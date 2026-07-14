// terminal.rs — embedded interactive terminal for Code mode. Each open panel gets a real PTY
// running the user's shell in the workspace folder; bytes stream to the frontend xterm over a
// Channel (base64, since raw PTY output isn't guaranteed valid UTF-8) and keystrokes come back via
// `terminal_write`. Mirrors the agent streaming shape (one command + Channel events), but here the
// lifecycle is a raw pty pair rather than a harness protocol.
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub(crate) enum TermEvent {
    // A chunk of shell output, base64-encoded.
    Data(String),
    // The shell process ended (EOF on the pty).
    Exit,
}

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

// One PTY per terminal id (the code chat id). A chat has at most one live terminal.
fn registry() -> &'static Mutex<HashMap<String, Pty>> {
    static REG: OnceLock<Mutex<HashMap<String, Pty>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(windows)]
fn default_shell() -> String {
    // PowerShell is present on every supported Windows and gives ANSI colours out of the box.
    "powershell.exe".to_string()
}

#[cfg(not(windows))]
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

/// Spawn a shell in `cwd` and stream its output over `on_event`. Reopening an existing id first
/// tears the old one down.
#[tauri::command]
pub fn terminal_open(
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: tauri::ipc::Channel<TermEvent>,
) -> Result<(), String> {
    close(&id); // idempotent: a stale pty for this id is replaced

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(default_shell());
    if !cwd.is_empty() {
        cmd.cwd(cwd);
    }
    // Propagate the app's environment (PATH, etc.) so cargo/npm/git resolve as in a normal shell.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    registry()
        .lock()
        .unwrap()
        .insert(id.clone(), Pty { master: pair.master, writer, child });

    // Blocking read pump on its own thread — the reader is an independent clone, so it never needs
    // the registry lock. On EOF (shell exit or teardown) drop the map entry and signal the frontend.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_event.send(TermEvent::Data(STANDARD.encode(&buf[..n]))).is_err() {
                        break; // frontend channel gone
                    }
                }
            }
        }
        registry().lock().unwrap().remove(&id);
        let _ = on_event.send(TermEvent::Exit);
    });

    Ok(())
}

#[tauri::command]
pub fn terminal_write(id: String, data: String) -> Result<(), String> {
    let mut reg = registry().lock().unwrap();
    let pty = reg.get_mut(&id).ok_or("terminal not open")?;
    pty.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    pty.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let reg = registry().lock().unwrap();
    if let Some(pty) = reg.get(&id) {
        pty.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_close(id: String) {
    close(&id);
}

fn close(id: &str) {
    if let Some(mut pty) = registry().lock().unwrap().remove(id) {
        let _ = pty.child.kill(); // dropping master closes the pty → read pump ends
    }
}

// Reap every live shell on app exit (called from lib.rs), so a quit never strands processes.
pub fn close_all() {
    let mut reg = registry().lock().unwrap();
    for (_, mut pty) in reg.drain() {
        let _ = pty.child.kill();
    }
}
