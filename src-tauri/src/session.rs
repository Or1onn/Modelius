// session.rs — warm agent sessions. A code chat keeps ONE long-lived CLI process across turns —
// follow-up turns ride the process's own stdio protocol instead of re-spawning per turn, skipping
// process boot and the resume transcript replay. Three protocols, one lifecycle:
// - Claude (stream-json multi-turn + control_requests, probe-verified 2.1.206)
// - Codex (`app-server` JSON-RPC threads/turns, probe-verified 0.142.5, lines in codex_proto.rs)
// - Kimi (`kimi acp` ACP sessions, probe-verified 0.25.0, lines in kimi_proto.rs)
// agent.rs owns argv/env/spawn and decides warm vs per-turn (run_once); this module owns the
// registry, the per-session stdout pump, and lifecycle (interrupt / idle reaping / LRU cap /
// app-exit cleanup).
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
    // Reasoning depth ("" = no flag). Claude-only: argv-only there, so a change respawns.
    // Codex effort is a native per-turn override (turn/start) — always "" in its fingerprint.
    pub effort: String,
    // (protocol, base_url, api_key) of a routed run; None = the CLI's native login.
    pub target: Option<(String, String, String)>,
    pub claude_token: Option<String>,
    // ChatGPT account identity of a native codex run (account id + token hash) — auth rotation
    // must respawn so the process re-reads the materialized CODEX_HOME. None for claude.
    pub codex_account: Option<String>,
}

// Per-protocol runtime state. Claude needs none beyond the shared fields; a codex app-server
// session tracks its JSON-RPC ids and the live thread/turn (codex_proto.rs builds the lines);
// a kimi acp session tracks its session id and the in-flight prompt (kimi_proto.rs).
pub(crate) enum SessionProto {
    Claude,
    Codex(CodexRuntime),
    Kimi(KimiRuntime),
}

pub(crate) struct CodexRuntime {
    // Set by the pump from the thread/start | thread/resume response.
    thread_id: Mutex<Option<String>>,
    // Set by the pump from turn/started; consumed by interrupt (turn/interrupt needs both ids).
    turn_id: Mutex<Option<String>>,
    // Client request ids. 1 = initialize, 2 = thread open (spawn_warm); turns/interrupts continue.
    next_id: std::sync::atomic::AtomicU64,
    // The pending thread-open request id + the waiter begin_turn blocks on (fresh spawns only).
    thread_open_req: u64,
    thread_ready_tx: Mutex<Option<tokio::sync::oneshot::Sender<Result<String, String>>>>,
    thread_ready_rx: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<Result<String, String>>>>,
    // The in-flight turn/start request id — an RpcError for it must fail the turn (no
    // turn/completed will follow).
    turn_req: Mutex<Option<u64>>,
}

impl CodexRuntime {
    pub fn new() -> Self {
        let (tx, rx) = tokio::sync::oneshot::channel();
        CodexRuntime {
            thread_id: Mutex::new(None),
            turn_id: Mutex::new(None),
            next_id: std::sync::atomic::AtomicU64::new(3),
            thread_open_req: 2,
            thread_ready_tx: Mutex::new(Some(tx)),
            thread_ready_rx: tokio::sync::Mutex::new(Some(rx)),
            turn_req: Mutex::new(None),
        }
    }

    fn take_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }
}

// Simpler than CodexRuntime: an ACP turn is bounded by the RESPONSE to our session/prompt
// request (not a notification), and session/cancel needs no turn id.
pub(crate) struct KimiRuntime {
    // From the session/new response — or pre-set when resuming (session/resume responses carry
    // no sessionId; the resume id IS the session id, so begin_turn never has to wait for it).
    session_id: Mutex<Option<String>>,
    // Client request ids. 1 = initialize, 2 = session open (spawn_warm); turns continue.
    next_id: std::sync::atomic::AtomicU64,
    session_open_req: u64,
    // The waiter begin_turn blocks on for a fresh session/new (resume paths skip it).
    session_ready_tx: Mutex<Option<tokio::sync::oneshot::Sender<Result<String, String>>>>,
    session_ready_rx: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<Result<String, String>>>>,
    // The in-flight session/prompt request id — its response ends the turn; an error for any
    // request while it is set fails the turn (set_model/set_mode are pipelined ahead of it).
    prompt_req: Mutex<Option<u64>>,
    // The model already applied via session/set_model — sent once per process (model changes
    // respawn via the fingerprint, like codex).
    model_sent: Mutex<Option<String>>,
    // Gates forwarding of notifications until the session-open response is consumed, so a
    // history replay (if the open method ever switches from resume to load) can't duplicate
    // into the live transcript.
    forwarding: AtomicBool,
}

impl KimiRuntime {
    pub fn new(resume: Option<String>) -> Self {
        let (tx, rx) = tokio::sync::oneshot::channel();
        KimiRuntime {
            session_id: Mutex::new(resume.filter(|s| !s.is_empty())),
            next_id: std::sync::atomic::AtomicU64::new(3),
            session_open_req: 2,
            session_ready_tx: Mutex::new(Some(tx)),
            session_ready_rx: tokio::sync::Mutex::new(Some(rx)),
            prompt_req: Mutex::new(None),
            model_sent: Mutex::new(None),
            forwarding: AtomicBool::new(false),
        }
    }

    fn take_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }
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
    proto: SessionProto,
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

    // Reconcile the CLI's permission mode with what the webview asked for this turn.
    // Claude: in-session set_permission_mode control_request (probe-verified: acked with
    // {"mode":...}, enforced next turn) — cheaper than a fingerprint respawn, and idempotent if
    // the CLI already switched itself (plan-approve's updatedPermissions setMode).
    // Codex: no-op — the mode rides every turn/start as approvalPolicy+sandboxPolicy overrides.
    // Kimi: no-op here — session/set_mode needs the session id, so begin_turn's Kimi arm
    // reconciles inline once the id is in hand.
    pub async fn reconcile_permission_mode(&self, mode: &str) -> std::io::Result<()> {
        if matches!(self.proto, SessionProto::Codex(_) | SessionProto::Kimi(_)) {
            return Ok(());
        }
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

    // Deliver one user turn over the session's protocol. Err = pipe gone / protocol failure —
    // the caller's write-failed retry respawns once.
    pub async fn begin_turn(&self, prompt: &str, model: &str, effort: &str, mode: &str) -> std::io::Result<()> {
        match &self.proto {
            SessionProto::Claude => {
                self.reconcile_permission_mode(mode).await?;
                let line = serde_json::json!({
                    "type": "user",
                    "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] }
                })
                .to_string();
                self.write_line(&line).await
            }
            SessionProto::Codex(rt) => {
                // Fresh spawn: wait for the thread/start | thread/resume response (the pump fires
                // the oneshot). Reused session: thread_id is already set, no wait.
                // (Guard extracted before the match — a temporary would live across the await.)
                let known = rt.thread_id.lock().unwrap().clone();
                let thread_id = match known {
                    Some(t) => t,
                    None => {
                        let rx = rt.thread_ready_rx.lock().await.take().ok_or_else(|| {
                            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "thread never opened")
                        })?;
                        let opened = tokio::time::timeout(Duration::from_secs(20), rx)
                            .await
                            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "thread open timed out"))?
                            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "session died"))?;
                        opened.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
                    }
                };
                let id = rt.take_id();
                *rt.turn_req.lock().unwrap() = Some(id);
                *rt.turn_id.lock().unwrap() = None;
                self.write_line(&crate::codex_proto::turn_start_line(id, &thread_id, prompt, model, effort, mode))
                    .await
            }
            SessionProto::Kimi(rt) => {
                let _ = effort; // no effort surface in ACP — thinking variants are model aliases
                // Fresh session/new: wait for the pump to consume the response (it carries the
                // session id). Resume/reused sessions have the id already.
                let known = rt.session_id.lock().unwrap().clone();
                let session_id = match known {
                    Some(s) => s,
                    None => {
                        let rx = rt.session_ready_rx.lock().await.take().ok_or_else(|| {
                            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "session never opened")
                        })?;
                        let opened = tokio::time::timeout(Duration::from_secs(20), rx)
                            .await
                            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "session open timed out"))?
                            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "session died"))?;
                        opened.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
                    }
                };
                // Arm the turn BEFORE the pipelined config writes: a rejected set_mode/set_model
                // must fail this turn deterministically (live-verified: an account whose login
                // populated no model catalog rejects set_model; racing the prompt write would
                // otherwise sometimes swallow the error into a silent empty turn).
                let id = rt.take_id();
                *rt.prompt_req.lock().unwrap() = Some(id);
                // A fresh acp session always boots in "default" mode (argv knobs don't bind —
                // probe P8), so spawn_warm registers it as "default" and the first turn
                // reconciles here. Acks ({}) are swallowed by the pump; errors while the prompt
                // is in flight fail the turn.
                if !mode.is_empty() && *self.permission_mode.lock().unwrap() != mode {
                    self.write_line(&crate::kimi_proto::set_mode_line(
                        rt.take_id(),
                        &session_id,
                        crate::kimi_proto::kimi_mode(mode),
                    ))
                    .await?;
                    *self.permission_mode.lock().unwrap() = mode.to_string();
                }
                // Model is pinned per process (fingerprint) but has no spawn-time flag — apply it
                // in-session once.
                if !model.is_empty() && rt.model_sent.lock().unwrap().as_deref() != Some(model) {
                    self.write_line(&crate::kimi_proto::set_model_line(rt.take_id(), &session_id, model))
                        .await?;
                    *rt.model_sent.lock().unwrap() = Some(model.to_string());
                }
                self.write_line(&crate::kimi_proto::prompt_line(id, &session_id, prompt)).await
            }
        }
    }

    // Ask the CLI to stop the running turn but keep the process warm; the pump then finishes the
    // turn normally. Claude: interrupt control_request → result subtype error_during_execution
    // (probe-verified 2.1.206). Codex: turn/interrupt → turn/completed status "interrupted"
    // (probe-verified 0.142.5). Kimi: session/cancel notification → the pending session/prompt
    // resolves with stopReason "cancelled" (probe-verified 0.25.0). Err (e.g. no live turn ids
    // yet) → caller falls back to kill.
    pub async fn interrupt(&self) -> std::io::Result<()> {
        match &self.proto {
            SessionProto::Claude => {
                let line = serde_json::json!({
                    "type": "control_request",
                    "request_id": format!("int-{}", uuid_ish()),
                    "request": { "subtype": "interrupt" }
                })
                .to_string();
                self.write_line(&line).await
            }
            SessionProto::Codex(rt) => {
                let (thread_id, turn_id) = {
                    let t = rt.thread_id.lock().unwrap().clone();
                    let u = rt.turn_id.lock().unwrap().clone();
                    match (t, u) {
                        (Some(t), Some(u)) => (t, u),
                        _ => {
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::NotFound,
                                "no live codex turn to interrupt",
                            ))
                        }
                    }
                };
                self.write_line(&crate::codex_proto::turn_interrupt_line(rt.take_id(), &thread_id, &turn_id))
                    .await
            }
            SessionProto::Kimi(rt) => {
                let session_id = rt.session_id.lock().unwrap().clone();
                match session_id {
                    Some(sid) => self.write_line(&crate::kimi_proto::cancel_line(&sid)).await,
                    None => Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "no live kimi session to interrupt",
                    )),
                }
            }
        }
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
    proto: SessionProto,
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
        proto,
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

// Long-lived stdout pump: every line goes to the attached turn; the protocol's turn-end marker
// ends that turn (transport-side Done + waiter wakeup) but — unlike the per-turn path — leaves
// stdin open so the CLI idles for the next turn. Stray lines between turns are dropped (codex
// lifecycle responses are consumed into the runtime first). EOF means the process died: fail any
// in-flight turn with the stderr tail and drop the registry entry.
fn spawn_pump(key: String, session: Arc<AgentSession>, stdout: tokio::process::ChildStdout) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Per-line verdict: (turn ended, turn failed message, forward the raw line). Claude
            // and codex forward every line; kimi withholds lifecycle responses (consumed into the
            // runtime) and pre-ready notifications (replay guard).
            let (end, fail, forward) = match &session.proto {
                // Claude: only a TOP-LEVEL result ends the turn (sidechain guard in is_result_line).
                SessionProto::Claude => (is_result_line(&line), None, true),
                SessionProto::Codex(rt) => {
                    let (end, fail) = pump_codex_line(rt, &line);
                    (end, fail, true)
                }
                SessionProto::Kimi(rt) => pump_kimi_line(rt, &line),
            };
            let mut guard = session.active.lock().unwrap();
            if let Some(t) = guard.as_ref() {
                if let Some(msg) = fail {
                    // The turn's request was rejected (RpcError) — no completion will follow.
                    let _ = t.channel.send(PipeEvent::Error(msg));
                    finish_turn(guard.take().unwrap());
                    continue;
                }
                if forward {
                    let _ = t.channel.send(PipeEvent::Line(line));
                }
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

// Codex pump bookkeeping for one stdout line. Returns (turn_ended, turn_failed_message).
// Tracks the thread id (thread open response → fires begin_turn's waiter), the live turn id
// (turn/started → interrupt target), and ends the attached turn only on a turn/completed whose
// threadId matches this session's — a sub-agent thread's completion must not end the parent turn.
fn pump_codex_line(rt: &CodexRuntime, line: &str) -> (bool, Option<String>) {
    use crate::codex_proto::{classify, CodexLine};
    match classify(line) {
        CodexLine::RpcResponse { id, thread_id } if id == rt.thread_open_req => {
            let outcome = match thread_id {
                Some(t) => {
                    *rt.thread_id.lock().unwrap() = Some(t.clone());
                    Ok(t)
                }
                None => Err("thread open response carried no thread id".to_string()),
            };
            if let Some(tx) = rt.thread_ready_tx.lock().unwrap().take() {
                let _ = tx.send(outcome);
            }
            (false, None)
        }
        CodexLine::RpcError { id, message } => {
            if id == rt.thread_open_req {
                if let Some(tx) = rt.thread_ready_tx.lock().unwrap().take() {
                    let _ = tx.send(Err(message));
                }
                (false, None)
            } else {
                let mut turn_req = rt.turn_req.lock().unwrap();
                if *turn_req == Some(id) {
                    *turn_req = None;
                    (false, Some(message))
                } else {
                    (false, None)
                }
            }
        }
        CodexLine::TurnStarted { thread_id, turn_id } => {
            if rt.thread_id.lock().unwrap().as_deref() == Some(thread_id.as_str()) {
                *rt.turn_id.lock().unwrap() = Some(turn_id);
            }
            (false, None)
        }
        CodexLine::TurnCompleted { thread_id } => {
            let ours = rt.thread_id.lock().unwrap().as_deref() == Some(thread_id.as_str());
            if ours {
                *rt.turn_id.lock().unwrap() = None;
                *rt.turn_req.lock().unwrap() = None;
            }
            (ours, None)
        }
        _ => (false, None),
    }
}

// Kimi pump bookkeeping for one stdout line. Returns (turn_ended, turn_failed_message, forward).
// Consumes the session-open response (fires begin_turn's waiter, opens the forwarding gate) and
// ends the attached turn on the session/prompt response — which IS forwarded, because the TS
// transform reads its stopReason for the finish metadata. set_model/set_mode acks are swallowed;
// an error while a prompt is in flight fails the turn (the config lines are pipelined ahead of
// it, so their rejection would otherwise strand the turn).
fn pump_kimi_line(rt: &KimiRuntime, line: &str) -> (bool, Option<String>, bool) {
    use crate::kimi_proto::{classify, KimiLine};
    match classify(line) {
        KimiLine::Response { id, session_id } if id == rt.session_open_req => {
            if let Some(sid) = session_id {
                // session/new carries the id; session/resume doesn't (it was pre-set).
                *rt.session_id.lock().unwrap() = Some(sid);
            }
            let outcome = match rt.session_id.lock().unwrap().clone() {
                Some(sid) => Ok(sid),
                None => Err("session open response carried no session id".to_string()),
            };
            rt.forwarding.store(true, Ordering::SeqCst);
            if let Some(tx) = rt.session_ready_tx.lock().unwrap().take() {
                let _ = tx.send(outcome);
            }
            (false, None, false)
        }
        KimiLine::Error { id, code, message } => {
            // authRequired (-32000): tell the user how to fix it — kimi's own login lives in the
            // built-in terminal (AuthModal wires the same command). An unconfigured model means
            // the login never populated the account's model catalog (live-verified: happens when
            // Kimi can't verify the account's membership) — say that instead of kimi's
            // edit-config.toml advice.
            let msg = if code == -32000 {
                format!("{} — open the built-in terminal and run `kimi login`", message)
            } else if message.contains("not configured in config.toml") {
                format!(
                    "{} — your Kimi account has no models available. Re-run `kimi login` in the built-in terminal and check that your Kimi Code membership is active.",
                    message
                )
            } else {
                message
            };
            if id == rt.session_open_req {
                if let Some(tx) = rt.session_ready_tx.lock().unwrap().take() {
                    let _ = tx.send(Err(msg));
                    return (false, None, false);
                }
                // Resume path: nobody waits on the oneshot — fall through and fail the turn.
            }
            let mut prompt_req = rt.prompt_req.lock().unwrap();
            if prompt_req.is_some() {
                *prompt_req = None;
                // The failure may have been the pipelined set_model — forget the "already sent"
                // mark so a retry re-asserts the model instead of silently running without one.
                *rt.model_sent.lock().unwrap() = None;
                (false, Some(msg), false)
            } else {
                (false, None, false)
            }
        }
        KimiLine::Response { id, .. } => {
            let mut prompt_req = rt.prompt_req.lock().unwrap();
            if *prompt_req == Some(id) {
                *prompt_req = None;
                (true, None, true) // the stopReason line — forwarded, ends the turn
            } else {
                (false, None, false) // set_model / set_mode ack — swallowed
            }
        }
        KimiLine::Other => (false, None, rt.forwarding.load(Ordering::SeqCst)),
    }
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
        let fp = |model: &str, effort: &str, token: Option<&str>, account: Option<&str>| Fingerprint {
            harness: "claude-code".into(),
            model: model.into(),
            cwd: "D:\\proj".into(),
            effort: effort.into(),
            target: None,
            claude_token: token.map(String::from),
            codex_account: account.map(String::from),
        };
        assert!(fp("opus", "", None, None) == fp("opus", "", None, None));
        assert!(fp("opus", "", None, None) != fp("sonnet", "", None, None)); // model change → respawn
        assert!(fp("opus", "high", None, None) != fp("opus", "max", None, None)); // claude effort is argv-only → respawn
        assert!(fp("opus", "", Some("t1"), None) != fp("opus", "", Some("t2"), None)); // auth rotation → respawn
        assert!(fp("gpt", "", None, Some("a:1")) != fp("gpt", "", None, Some("a:2"))); // codex account rotation → respawn
        // permission mode is not part of the fingerprint at all (switched in-session);
        // codex effort is not either (per-turn turn/start override) — agent_run passes "" there
    }

    #[test]
    fn pump_codex_line_tracks_the_thread_and_ends_only_its_own_turns() {
        let rt = CodexRuntime::new();
        // thread open response (id 2) → thread id learned + begin_turn's waiter fired
        let (end, fail) = pump_codex_line(&rt, r#"{"id":2,"result":{"thread":{"id":"th-1"},"model":"gpt-5.5"}}"#);
        assert_eq!((end, fail.is_none()), (false, true));
        assert_eq!(rt.thread_id.lock().unwrap().as_deref(), Some("th-1"));
        assert!(rt.thread_ready_tx.lock().unwrap().is_none()); // oneshot consumed

        // turn/started on our thread → interrupt target captured
        let started = r#"{"method":"turn/started","params":{"threadId":"th-1","turn":{"id":"tu-1"}}}"#;
        pump_codex_line(&rt, started);
        assert_eq!(rt.turn_id.lock().unwrap().as_deref(), Some("tu-1"));

        // a sub-agent thread's completion must NOT end our turn
        let foreign = r#"{"method":"turn/completed","params":{"threadId":"th-OTHER","turn":{"id":"x","status":"completed"}}}"#;
        assert_eq!(pump_codex_line(&rt, foreign).0, false);

        // our own completion ends the turn and clears the live turn id
        let ours = r#"{"method":"turn/completed","params":{"threadId":"th-1","turn":{"id":"tu-1","status":"interrupted"}}}"#;
        assert_eq!(pump_codex_line(&rt, ours).0, true);
        assert!(rt.turn_id.lock().unwrap().is_none());
    }

    #[test]
    fn pump_codex_line_fails_the_turn_on_a_rejected_turn_start() {
        let rt = CodexRuntime::new();
        *rt.turn_req.lock().unwrap() = Some(5);
        // an error for someone else's request is not ours to fail on
        assert!(pump_codex_line(&rt, r#"{"id":9,"error":{"code":-1,"message":"nope"}}"#).1.is_none());
        // an error for the in-flight turn/start fails the turn (no turn/completed will follow)
        let (end, fail) = pump_codex_line(&rt, r#"{"id":5,"error":{"code":-32600,"message":"bad params"}}"#);
        assert_eq!(end, false);
        assert_eq!(fail.as_deref(), Some("bad params"));
        assert!(rt.turn_req.lock().unwrap().is_none());
    }

    #[test]
    fn pump_kimi_line_opens_the_session_and_ends_the_turn_on_the_prompt_response() {
        let rt = KimiRuntime::new(None);
        // notification BEFORE the session opens → suppressed (replay guard)
        let note = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"H"}}}}"#;
        assert_eq!(pump_kimi_line(&rt, note), (false, None, false));

        // session/new response (id 2) → session id learned, gate opened, waiter fired, NOT forwarded
        let open = r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1","configOptions":[]}}"#;
        assert_eq!(pump_kimi_line(&rt, open), (false, None, false));
        assert_eq!(rt.session_id.lock().unwrap().as_deref(), Some("s1"));
        assert!(rt.session_ready_tx.lock().unwrap().is_none()); // oneshot consumed

        // notification after ready → forwarded
        assert_eq!(pump_kimi_line(&rt, note), (false, None, true));
        // server request (permission) → forwarded too, TS answers it
        let perm = r#"{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{}}"#;
        assert_eq!(pump_kimi_line(&rt, perm), (false, None, true));

        *rt.prompt_req.lock().unwrap() = Some(5);
        // a set_model / set_mode ack is swallowed and does NOT end the turn
        assert_eq!(pump_kimi_line(&rt, r#"{"jsonrpc":"2.0","id":3,"result":{}}"#), (false, None, false));
        // the prompt response ends the turn AND is forwarded (transform reads stopReason)
        let done = r#"{"jsonrpc":"2.0","id":5,"result":{"stopReason":"end_turn"}}"#;
        assert_eq!(pump_kimi_line(&rt, done), (true, None, true));
        assert!(rt.prompt_req.lock().unwrap().is_none());
    }

    #[test]
    fn pump_kimi_line_surfaces_auth_errors_with_the_login_hint() {
        // Fresh spawn: the session-open error goes to begin_turn's waiter
        let rt = KimiRuntime::new(None);
        let auth_err = r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}"#;
        assert_eq!(pump_kimi_line(&rt, auth_err), (false, None, false));
        let rx = rt.session_ready_rx.try_lock().unwrap().take().unwrap();
        let err = rx.blocking_recv().unwrap().unwrap_err();
        assert!(err.contains("kimi login"), "hint missing: {}", err);

        // Resume path (session id pre-set, waiter unused): an error while the prompt is in
        // flight fails the turn instead
        let rt = KimiRuntime::new(Some("s1".into()));
        rt.session_ready_tx.lock().unwrap().take(); // waiter already consumed by a prior turn
        *rt.prompt_req.lock().unwrap() = Some(4);
        let (end, fail, _) = pump_kimi_line(&rt, r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}"#);
        assert_eq!(end, false);
        assert!(fail.unwrap().contains("kimi login"));
        assert!(rt.prompt_req.lock().unwrap().is_none());

        // an error with no turn in flight is swallowed
        let rt = KimiRuntime::new(Some("s1".into()));
        rt.session_ready_tx.lock().unwrap().take();
        assert_eq!(
            pump_kimi_line(&rt, r#"{"jsonrpc":"2.0","id":9,"error":{"code":-1,"message":"nope"}}"#),
            (false, None, false)
        );
    }

    #[test]
    fn kimi_runtime_presets_the_session_id_on_resume() {
        let rt = KimiRuntime::new(Some("session_prev".into()));
        assert_eq!(rt.session_id.lock().unwrap().as_deref(), Some("session_prev"));
        // resume responses carry no sessionId — the pre-set id must survive the open response
        let open = r#"{"jsonrpc":"2.0","id":2,"result":{"configOptions":[]}}"#;
        pump_kimi_line(&rt, open);
        assert_eq!(rt.session_id.lock().unwrap().as_deref(), Some("session_prev"));
        assert!(rt.forwarding.load(Ordering::SeqCst));
        // empty resume string = fresh session
        assert!(KimiRuntime::new(Some(String::new())).session_id.lock().unwrap().is_none());
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
