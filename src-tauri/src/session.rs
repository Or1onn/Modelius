// session.rs — warm agent sessions. A code chat on a stdin_prompt harness (claude) keeps ONE
// long-lived CLI process across turns: follow-up user messages are written to its stdin
// (stream-json multi-turn, probe-verified on claude 2.1.206) instead of re-spawning per turn —
// skipping process boot and the `--resume` transcript replay. agent.rs owns argv/env/spawn and
// decides warm vs per-turn (run_once); this module owns the registry, the per-session stdout
// pump, and lifecycle (interrupt / idle reaping / LRU cap / app-exit cleanup).
use crate::agent::{PipeEvent, StdinHandle};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

// Each warm claude process holds its whole context in RAM (~200–400MB RSS observed): cap the pool
// so a user hopping between chats can't accumulate gigabytes of idle CLIs. 3 covers the realistic
// "a couple of parallel chats" pattern; older sessions fall back to per-spawn `--resume`.
pub(crate) const WARM_CAP: usize = 3;
// A session idle this long is reaped (graceful drop); the next turn transparently respawns with
// `--resume`. Long enough to cover a think-and-reply pause, short enough to bound idle footprint.
pub(crate) const IDLE_REAP: Duration = Duration::from_secs(600);

// What must match for a live process to be reused. `permission_mode` is deliberately absent — it
// is switched in-session via a set_permission_mode control_request (plan→approve flips the mode on
// virtually every planned task; a fingerprint miss there would kill warmth in the hottest flow).
// `resume` is spawn-time-only, so it's absent too.
#[derive(PartialEq, Clone)]
pub(crate) struct Fingerprint {
    pub harness: String,
    pub model: String,
    pub cwd: String,
    // Reasoning depth ("" = no flag). argv-only — no in-session switch — so a change respawns.
    pub effort: String,
    // (protocol, base_url, api_key) of a routed run; None = the CLI's native login.
    pub target: Option<(String, String, String)>,
    pub claude_token: Option<String>,
}

// The turn currently streaming into the webview. Tauri channels are per-invoke, so every turn
// brings its own; the pump routes each stdout line to whichever turn is attached. `done` wakes the
// awaiting `agent_run` once the turn's `result` line has been forwarded.
struct ActiveTurn {
    channel: tauri::ipc::Channel<PipeEvent>,
    done: Option<tokio::sync::oneshot::Sender<()>>,
}

pub(crate) struct AgentSession {
    fingerprint: Fingerprint,
    // Session-held stdin clone. Taken (dropped) on close so the CLI sees EOF once the per-turn
    // clone in agent_stdins is gone too. tokio Mutex on the handle (async writes); std Mutex on
    // the slot (never held across await).
    stdin: Mutex<Option<StdinHandle>>,
    // For start_kill / bounded wait. tokio Mutex: `wait()` is async.
    child: tokio::sync::Mutex<tokio::process::Child>,
    active: Mutex<Option<ActiveTurn>>,
    // Routed runs keep their gateway for the session's lifetime (per-chat instead of per-turn).
    gateway: Option<crate::gateway::Gateway>,
    // Cleared on close/kill/stdout-EOF; a dead session is never reused (fingerprint match requires it).
    alive: AtomicBool,
    last_used: Mutex<Instant>,
    // The permission mode the CLI currently runs under; reconciled per turn via
    // set_permission_mode when the webview asks for a different one.
    permission_mode: Mutex<String>,
    // Rolling tail of stderr. A long-lived process must have stderr drained continuously (a full
    // pipe buffer would block the CLI); the tail feeds the error surfaced on unexpected death.
    stderr_tail: Mutex<String>,
}

// The CLI emits lines as compact JSON with `type` first; inside strings the quotes would be
// escaped, so this prefix can't occur mid-string. Only a TOP-LEVEL result ends the turn — the
// stream-json types allow sidechain (subagent) results carrying parent_tool_use_id, and ending
// the turn on one would strand the rest of the CLI's output. Result lines are rare, so the
// confirming JSON parse costs nothing. Centralized: a format change is a one-line fix.
pub(crate) fn is_result_line(line: &str) -> bool {
    if !line.starts_with("{\"type\":\"result\"") {
        return false;
    }
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(v) => v.get("parent_tool_use_id").map(|p| p.is_null()).unwrap_or(true),
        Err(_) => true, // prefix matched but unparseable — fall back to the old behavior
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<AgentSession>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<AgentSession>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

impl AgentSession {
    pub fn matches(&self, fp: &Fingerprint) -> bool {
        self.alive.load(Ordering::SeqCst) && self.fingerprint == *fp
    }

    pub fn stdin(&self) -> Option<StdinHandle> {
        self.stdin.lock().unwrap().clone()
    }

    pub fn touch(&self) {
        *self.last_used.lock().unwrap() = Instant::now();
    }

    // Attach the next turn and hand back its completion signal. If a turn is somehow still
    // attached (webview raced a resend), steal it: the old channel gets Done so its stream closes.
    pub fn attach_turn(&self, channel: tauri::ipc::Channel<PipeEvent>) -> tokio::sync::oneshot::Receiver<()> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut guard = self.active.lock().unwrap();
        if let Some(old) = guard.take() {
            finish_turn(old);
        }
        *guard = Some(ActiveTurn { channel, done: Some(tx) });
        rx
    }

    // Waiter-side turn teardown (cancel paths): close the turn's stream; the process itself is
    // handled by the caller (interrupt keeps it, kill doesn't).
    pub fn detach_turn(&self) {
        if let Some(t) = self.active.lock().unwrap().take() {
            finish_turn(t);
        }
    }

    // Drop the turn WITHOUT signaling its channel — for the write-failed retry path, where the
    // same webview stream must stay open for the respawned session's attempt.
    pub fn abandon_turn(&self) {
        self.active.lock().unwrap().take();
    }

    // Write one stream-json line to the CLI's stdin. Err = pipe gone (process died between turns).
    pub async fn write_line(&self, line: &str) -> std::io::Result<()> {
        let handle = self
            .stdin()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "stdin closed"))?;
        let mut s = handle.lock().await;
        s.write_all(line.as_bytes()).await?;
        s.write_all(b"\n").await?;
        s.flush().await
    }

    // Reconcile the CLI's permission mode with what the webview asked for this turn. In-session
    // switch (probe-verified: acked with {"mode":...}, enforced next turn) — cheaper than a
    // fingerprint respawn, and idempotent if the CLI already switched itself (plan-approve's
    // updatedPermissions setMode).
    pub async fn reconcile_permission_mode(&self, mode: &str) -> std::io::Result<()> {
        if mode.is_empty() || *self.permission_mode.lock().unwrap() == mode {
            return Ok(());
        }
        let line = serde_json::json!({
            "type": "control_request",
            "request_id": format!("pm-{}", uuid_ish()),
            "request": { "subtype": "set_permission_mode", "mode": mode }
        })
        .to_string();
        self.write_line(&line).await?;
        *self.permission_mode.lock().unwrap() = mode.to_string();
        Ok(())
    }

    // Ask the CLI to stop the running turn but keep the process warm. The CLI acks instantly and
    // ends the turn with a `result` (subtype error_during_execution) — the pump then finishes the
    // turn normally. Probe-verified on 2.1.206.
    pub async fn interrupt(&self) -> std::io::Result<()> {
        let line = serde_json::json!({
            "type": "control_request",
            "request_id": format!("int-{}", uuid_ish()),
            "request": { "subtype": "interrupt" }
        })
        .to_string();
        self.write_line(&line).await
    }

    // Hard stop: mark dead, drop stdin, kill, free the gateway. For cancel timeouts and app exit.
    pub async fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.stdin.lock().unwrap().take();
        let _ = self.child.lock().await.start_kill();
        if let Some(g) = &self.gateway {
            g.shutdown();
        }
    }

    // Graceful close: stdin EOF → bounded wait for the CLI to exit on its own → kill. Used by
    // eviction, idle reaping, and chat deletion (no turn should be in flight; detach just in case).
    pub async fn close(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.detach_turn();
        self.stdin.lock().unwrap().take();
        {
            let mut child = self.child.lock().await;
            if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
                let _ = child.start_kill();
            }
        }
        if let Some(g) = &self.gateway {
            g.shutdown();
        }
    }
}

// Close a turn's stream: Done to the webview, completion to the awaiting agent_run.
fn finish_turn(mut t: ActiveTurn) {
    let _ = t.channel.send(PipeEvent::Done);
    if let Some(tx) = t.done.take() {
        let _ = tx.send(());
    }
}

// Cheap unique-enough id for control_request lines (no uuid crate dependency).
fn uuid_ish() -> String {
    format!("{:x}", std::time::SystemTime::UNIX_EPOCH.elapsed().map(|d| d.as_nanos()).unwrap_or(0))
}

pub(crate) fn get(key: &str) -> Option<Arc<AgentSession>> {
    sessions().lock().unwrap().get(key).cloned()
}

pub(crate) fn remove(key: &str) -> Option<Arc<AgentSession>> {
    sessions().lock().unwrap().remove(key)
}

// Register a freshly spawned warm CLI: wires the stdout pump + stderr drain and inserts it.
// Also enforces the LRU cap: the caller closes whatever this returns (evicted sessions).
pub(crate) fn spawn_session(
    key: &str,
    fingerprint: Fingerprint,
    permission_mode: String,
    mut child: tokio::process::Child,
    gateway: Option<crate::gateway::Gateway>,
) -> Result<(Arc<AgentSession>, Vec<Arc<AgentSession>>), String> {
    // Free the gateway on the (unreachable-with-piped-stdio) failure paths — a dropped Gateway
    // detaches its task instead of aborting it, which would leak the listener.
    let (stdin, stdout, stderr) = match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
        (Some(si), Some(so), Some(se)) => (si, so, se),
        _ => {
            let _ = child.start_kill();
            if let Some(g) = &gateway {
                g.shutdown();
            }
            return Err("agent process spawned without piped stdio".to_string());
        }
    };

    let session = Arc::new(AgentSession {
        fingerprint,
        stdin: Mutex::new(Some(Arc::new(tokio::sync::Mutex::new(stdin)))),
        child: tokio::sync::Mutex::new(child),
        active: Mutex::new(None),
        gateway,
        alive: AtomicBool::new(true),
        last_used: Mutex::new(Instant::now()),
        permission_mode: Mutex::new(permission_mode),
        stderr_tail: Mutex::new(String::new()),
    });

    spawn_stderr_drain(session.clone(), stderr);
    spawn_pump(key.to_string(), session.clone(), stdout);
    ensure_reaper();

    let mut evicted = Vec::new();
    {
        let mut map = sessions().lock().unwrap();
        if let Some(old) = map.insert(key.to_string(), session.clone()) {
            evicted.push(old); // replaced a stale same-key session — close it too
        }
        while map.len() > WARM_CAP {
            match lru_victim(map.iter().map(|(k, s)| (k.clone(), *s.last_used.lock().unwrap())), key) {
                Some(k) => evicted.extend(map.remove(&k)),
                None => break,
            }
        }
    }
    Ok((session, evicted))
}

// Least-recently-used key among candidates, never the one being spawned.
fn lru_victim(entries: impl Iterator<Item = (String, Instant)>, keep: &str) -> Option<String> {
    entries.filter(|(k, _)| k != keep).min_by_key(|(_, t)| *t).map(|(k, _)| k)
}

// Long-lived stdout pump: every line goes to the attached turn; a `result` line ends that turn
// (transport-side Done + waiter wakeup) but — unlike the per-turn path — leaves stdin open so the
// CLI idles for the next stream-json user message. Stray lines between turns are dropped. EOF
// means the process died: fail any in-flight turn with the stderr tail and drop the registry entry.
fn spawn_pump(key: String, session: Arc<AgentSession>, stdout: tokio::process::ChildStdout) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let end = is_result_line(&line);
            let mut guard = session.active.lock().unwrap();
            if let Some(t) = guard.as_ref() {
                let _ = t.channel.send(PipeEvent::Line(line));
                if end {
                    finish_turn(guard.take().unwrap());
                }
            }
        }
        session.alive.store(false, Ordering::SeqCst);
        if let Some(t) = session.active.lock().unwrap().take() {
            let tail = session.stderr_tail.lock().unwrap().trim().to_string();
            let _ = t.channel.send(PipeEvent::Error(if tail.is_empty() {
                "agent process exited unexpectedly".to_string()
            } else {
                tail
            }));
            finish_turn(t);
        }
        if let Some(g) = &session.gateway {
            g.shutdown();
        }
        // Only drop our own entry — a respawn may already occupy the key.
        let mut map = sessions().lock().unwrap();
        if map.get(&key).map(|s| Arc::ptr_eq(s, &session)).unwrap_or(false) {
            map.remove(&key);
        }
    });
}

// Keep stderr flowing into a bounded tail (last ~2000 chars) for the death message, and mirror
// each line to the live turn as transient status — mid-turn retry/backoff notices land on stderr
// and the webview would otherwise show dead silence while the CLI waits out an API stall.
fn spawn_stderr_drain(session: Arc<AgentSession>, stderr: tokio::process::ChildStderr) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            {
                let mut t = session.stderr_tail.lock().unwrap();
                t.push_str(&line);
                t.push('\n');
                if t.len() > 4000 {
                    let cut = t.len() - 2000;
                    let cut = t.char_indices().map(|(i, _)| i).find(|&i| i >= cut).unwrap_or(0);
                    *t = t[cut..].to_string();
                }
            }
            if let Some(t) = session.active.lock().unwrap().as_ref() {
                let _ = t.channel.send(PipeEvent::Stderr(line));
            }
        }
    });
}

// Sweep for idle sessions every minute; spawned once with the first warm session.
fn ensure_reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let expired: Vec<Arc<AgentSession>> = {
                    let mut map = sessions().lock().unwrap();
                    let keys: Vec<String> = map
                        .iter()
                        .filter(|(_, s)| {
                            s.active.lock().unwrap().is_none() && s.last_used.lock().unwrap().elapsed() > IDLE_REAP
                        })
                        .map(|(k, _)| k.clone())
                        .collect();
                    keys.into_iter().filter_map(|k| map.remove(&k)).collect()
                };
                for s in expired {
                    s.close().await;
                }
            }
        });
    });
}

// Drop one chat's warm session (chat deleted / explicit close from the webview).
pub(crate) async fn close_session(key: &str) {
    if let Some(s) = remove(key) {
        s.close().await;
    }
}

// App exit: synchronous best-effort kill of every warm CLI (RunEvent::Exit is not async).
// try_lock is safe here — nothing else contends at exit; kill_on_drop backstops any miss.
pub(crate) fn close_all() {
    let all: Vec<Arc<AgentSession>> = sessions().lock().unwrap().drain().map(|(_, s)| s).collect();
    for s in all {
        s.alive.store(false, Ordering::SeqCst);
        s.stdin.lock().unwrap().take();
        if let Ok(mut child) = s.child.try_lock() {
            let _ = child.start_kill();
        }
        if let Some(g) = &s.gateway {
            g.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_top_level_result_lines_end_the_turn() {
        assert!(is_result_line(r#"{"type":"result","subtype":"success"}"#));
        assert!(is_result_line(r#"{"type":"result","subtype":"success","parent_tool_use_id":null}"#));
        // a subagent's sidechain result must NOT end the turn
        assert!(!is_result_line(r#"{"type":"result","subtype":"success","parent_tool_use_id":"toolu_01x"}"#));
        assert!(!is_result_line(r#"{"type":"assistant","message":{}}"#));
        // the prefix inside a string value is escaped, so it can't false-positive
        assert!(!is_result_line(r#"{"type":"user","text":"{\"type\":\"result\""}"#));
        assert!(!is_result_line(""));
    }

    #[test]
    fn fingerprint_matches_on_run_identity_not_mode() {
        let fp = |model: &str, effort: &str, token: Option<&str>| Fingerprint {
            harness: "claude-code".into(),
            model: model.into(),
            cwd: "D:\\proj".into(),
            effort: effort.into(),
            target: None,
            claude_token: token.map(String::from),
        };
        assert!(fp("opus", "", None) == fp("opus", "", None));
        assert!(fp("opus", "", None) != fp("sonnet", "", None)); // model change → respawn
        assert!(fp("opus", "high", None) != fp("opus", "max", None)); // effort is argv-only → respawn
        assert!(fp("opus", "", Some("t1")) != fp("opus", "", Some("t2"))); // auth rotation → respawn
        // permission mode is not part of the fingerprint at all (switched in-session)
    }

    #[test]
    fn lru_victim_picks_oldest_and_never_the_kept_key() {
        let now = Instant::now();
        let entries = vec![
            ("a".to_string(), now - Duration::from_secs(30)),
            ("b".to_string(), now - Duration::from_secs(300)), // oldest
            ("c".to_string(), now),
        ];
        assert_eq!(lru_victim(entries.clone().into_iter(), "x"), Some("b".to_string()));
        assert_eq!(lru_victim(entries.into_iter(), "b"), Some("a".to_string())); // keep excluded
        assert_eq!(lru_victim(std::iter::empty(), "x"), None);
    }
}
