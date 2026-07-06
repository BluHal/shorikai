//! pty-host: PTY session manager. Tauri-free so it can be tested headless;
//! the app layer injects an event callback that forwards to the webview.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PtyEvent {
    Data { id: u32, data: String },
    Exit { id: u32 },
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

type Sessions = Arc<Mutex<HashMap<u32, Session>>>;

pub struct PtyHost {
    sessions: Sessions,
    next_id: AtomicU32,
    on_event: Arc<dyn Fn(PtyEvent) + Send + Sync>,
}

impl PtyHost {
    pub fn new(on_event: impl Fn(PtyEvent) + Send + Sync + 'static) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU32::new(1),
            on_event: Arc::new(on_event),
        }
    }

    /// Spawn `cmd` (default: `$SHELL -l`) in a new PTY. Returns the session
    /// id and the child pid. `env` adds/overrides variables (debug terminals
    /// inject NODE_OPTIONS et al.).
    pub fn spawn(
        &self,
        cmd: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        env: Option<std::collections::HashMap<String, String>>,
    ) -> Result<(u32, Option<u32>), String> {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut builder = match cmd {
            Some(c) => CommandBuilder::new(c),
            None => {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
                let mut b = CommandBuilder::new(shell);
                b.arg("-l");
                b
            }
        };
        builder.env("TERM", "xterm-256color");
        builder.env("COLORTERM", "truecolor");
        if let Some(vars) = env {
            for (k, v) in vars {
                builder.env(k, v);
            }
        }
        if let Some(dir) = cwd {
            builder.cwd(dir);
        }

        let child = pty
            .slave
            .spawn_command(builder)
            .map_err(|e| e.to_string())?;
        let child_pid = child.process_id();
        drop(pty.slave);
        let reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pty.master.take_writer().map_err(|e| e.to_string())?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                master: pty.master,
                writer,
                child,
            },
        );

        let sessions = Arc::clone(&self.sessions);
        let on_event = Arc::clone(&self.on_event);
        std::thread::spawn(move || read_loop(id, reader, sessions, on_event));
        Ok((id, child_pid))
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(&id).ok_or("no such pty session")?;
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions.get(&id).ok_or("no such pty session")?;
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, id: u32) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(&id).ok_or("no such pty session")?;
        s.child.kill().map_err(|e| e.to_string())
    }

    /// Kill every session. A freshly booted frontend owns no sessions, so
    /// anything alive at that point was orphaned by a webview reload.
    /// ponytail: revisit if terminal reattach-across-reload ever lands (#12)
    pub fn kill_all(&self) {
        for s in self.sessions.lock().unwrap().values_mut() {
            let _ = s.child.kill(); // reader threads reap and emit Exit
        }
    }
}

/// Pump PTY output to the event callback, holding back bytes of a UTF-8
/// character split across read chunks so the frontend always gets valid text.
fn read_loop(
    id: u32,
    mut reader: Box<dyn Read + Send>,
    sessions: Sessions,
    on_event: Arc<dyn Fn(PtyEvent) + Send + Sync>,
) {
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break, // EOF (macOS reports EIO on child exit)
            Ok(n) => n,
        };
        pending.extend_from_slice(&buf[..n]);
        let valid_len = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid_len > 0 {
            let data = std::str::from_utf8(&pending[..valid_len])
                .unwrap()
                .to_owned();
            on_event(PtyEvent::Data { id, data });
            pending.drain(..valid_len);
        }
        if pending.len() > 3 {
            // Not a partial UTF-8 char; flush lossy rather than stall.
            on_event(PtyEvent::Data {
                id,
                data: String::from_utf8_lossy(&pending).into_owned(),
            });
            pending.clear();
        }
    }
    if let Some(mut s) = sessions.lock().unwrap().remove(&id) {
        let _ = s.child.wait(); // reap
    }
    on_event(PtyEvent::Exit { id });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// Drain events until `needle` shows up in accumulated output.
    fn wait_for_output(rx: &mpsc::Receiver<PtyEvent>, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut acc = String::new();
        while Instant::now() < deadline {
            if let Ok(PtyEvent::Data { data, .. }) = rx.recv_timeout(Duration::from_millis(200)) {
                acc.push_str(&data);
                if acc.contains(needle) {
                    return acc;
                }
            }
        }
        panic!("timed out waiting for {needle:?}; got: {acc:?}");
    }

    #[test]
    fn echo_roundtrip_resize_kill() {
        let (tx, rx) = mpsc::channel();
        let host = PtyHost::new(move |e| {
            tx.send(e).ok();
        });

        let (id, pid) = host.spawn(Some("sh".into()), None, 80, 24, None).unwrap();
        assert!(pid.is_some(), "spawn should report the child pid");

        // $((20+3)) keeps the expected string out of the echoed input line.
        host.write(id, "echo round-trip-$((20+3))\r").unwrap();
        wait_for_output(&rx, "round-trip-23");

        // Retry: right after a command, bash may still be settling at its
        // prompt and the first stty can race the resize.
        let mut resized = false;
        for _ in 0..5 {
            host.resize(id, 100, 40).unwrap();
            host.write(id, "stty size\r").unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut acc = String::new();
            while Instant::now() < deadline && !acc.contains("40 100") {
                if let Ok(PtyEvent::Data { data, .. }) = rx.recv_timeout(Duration::from_millis(200))
                {
                    acc.push_str(&data);
                }
            }
            if acc.contains("40 100") {
                resized = true;
                break;
            }
        }
        assert!(resized, "PTY never reported resized dimensions");

        host.kill(id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match rx.recv_timeout(deadline - Instant::now()) {
                Ok(PtyEvent::Exit { id: exited }) => {
                    assert_eq!(exited, id);
                    break;
                }
                Ok(_) => {}
                Err(e) => panic!("no exit event after kill: {e}"),
            }
        }
        assert!(host.write(id, "x").is_err(), "session should be gone");
    }
}
