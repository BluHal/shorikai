//! lsp-host: spawns language servers found on PATH and proxies LSP's
//! Content-Length framed JSON-RPC between the frontend language client and
//! the server process. Protocol intelligence lives in the frontend; this is
//! a framed pipe with lifecycle.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LspEvent {
    Message { id: u32, message: Value },
    Exit { id: u32, code: Option<i32> },
}

/// Filetype -> server mapping lives in a user-editable config file,
/// ~/.config/shorikai/lsp.json; created with sensible defaults.
pub fn load_server_config() -> Result<Value, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = std::path::Path::new(&home).join(".config/shorikai");
    let path = dir.join("lsp.json");
    if !path.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let default = serde_json::json!({
            "servers": {
                "typescript": {
                    "command": "typescript-language-server",
                    "args": ["--stdio"],
                    "languages": ["typescript", "javascript"],
                    "install": { "tool": "npm", "packages": ["typescript-language-server", "typescript"] }
                },
                "angular": {
                    "command": "ngserver",
                    "args": ["--stdio"],
                    "languages": ["html"],
                    "install": { "tool": "npm", "packages": ["@angular/language-server"] }
                },
                "go": {
                    "command": "gopls",
                    "args": [],
                    "languages": ["go"],
                    "install": { "tool": "go", "packages": ["golang.org/x/tools/gopls@latest"] }
                }
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&default).unwrap())
            .map_err(|e| e.to_string())?;
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("invalid {}: {e}", path.display()))
}

pub fn which(command: &str) -> bool {
    if command.contains('/') {
        return std::path::Path::new(command).is_file();
    }
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    path.split(':').any(|dir| {
        let candidate = std::path::Path::new(dir).join(command);
        candidate.is_file()
            && std::fs::metadata(&candidate)
                .map(|m| std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0)
                .unwrap_or(false)
    })
}

/// One-click install: shells out to the package manager the config names.
pub fn install(tool: &str, packages: &[String]) -> Result<String, String> {
    let (cmd, args): (&str, Vec<&str>) = match tool {
        "npm" => ("npm", ["install", "-g"].into_iter().chain(packages.iter().map(String::as_str)).collect()),
        "go" => ("go", ["install"].into_iter().chain(packages.iter().map(String::as_str)).collect()),
        "brew" => ("brew", ["install"].into_iter().chain(packages.iter().map(String::as_str)).collect()),
        other => return Err(format!("unknown install tool {other:?}")),
    };
    let out = Command::new(cmd)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run {cmd}: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(tail(&stdout, 600))
    } else {
        Err(tail(&format!("{stderr}\n{stdout}"), 1200))
    }
}

fn tail(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.len() <= max {
        return t.to_owned();
    }
    let mut cut = t.len() - max;
    while !t.is_char_boundary(cut) {
        cut += 1;
    }
    format!("…{}", &t[cut..])
}

struct Server {
    child: Child,
    stdin: ChildStdin,
}

pub struct LspHost {
    servers: Arc<Mutex<HashMap<u32, Server>>>,
    next_id: AtomicU32,
    on_event: Arc<dyn Fn(LspEvent) + Send + Sync>,
}

impl LspHost {
    pub fn new(on_event: impl Fn(LspEvent) + Send + Sync + 'static) -> Self {
        Self {
            servers: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU32::new(1),
            on_event: Arc::new(on_event),
        }
    }

    pub fn start(&self, command: &str, args: &[String], cwd: &str) -> Result<u32, String> {
        let mut child = Command::new(command)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("failed to spawn {command}: {e}"))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.servers.lock().unwrap().insert(id, Server { child, stdin });

        let servers = Arc::clone(&self.servers);
        let on_event = Arc::clone(&self.on_event);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(message)) = read_frame(&mut reader) {
                on_event(LspEvent::Message { id, message });
            }
            let code = servers
                .lock()
                .unwrap()
                .remove(&id)
                .and_then(|mut s| s.child.wait().ok().and_then(|st| st.code()));
            on_event(LspEvent::Exit { id, code });
        });
        Ok(id)
    }

    pub fn send(&self, id: u32, message: &Value) -> Result<(), String> {
        let mut servers = self.servers.lock().unwrap();
        let s = servers.get_mut(&id).ok_or("no such language server")?;
        let body = serde_json::to_vec(message).map_err(|e| e.to_string())?;
        write!(s.stdin, "Content-Length: {}\r\n\r\n", body.len())
            .and_then(|_| s.stdin.write_all(&body))
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, id: u32) -> Result<(), String> {
        let mut servers = self.servers.lock().unwrap();
        let s = servers.get_mut(&id).ok_or("no such language server")?;
        kill_group(&mut s.child);
        Ok(())
    }

    pub fn kill_all(&self) {
        for s in self.servers.lock().unwrap().values_mut() {
            kill_group(&mut s.child);
        }
    }
}

fn kill_group(child: &mut Child) {
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
}

/// Read one Content-Length framed JSON-RPC message. Ok(None) on clean EOF.
/// Shared with dap-core: DAP uses the same framing.
pub fn read_frame(reader: &mut impl BufRead) -> std::io::Result<Option<Value>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None); // EOF
        }
        let line = line.trim_end();
        if line.is_empty() {
            break; // end of headers
        }
        if let Some(v) = line
            .to_ascii_lowercase()
            .strip_prefix("content-length:")
        {
            content_length = v.trim().parse().ok();
        }
    }
    let len = content_length
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "no content-length"))?;
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frame_parsing_round_trip() {
        let a = r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#;
        let b = r#"{"jsonrpc":"2.0","method":"note","params":{"x":"é"}}"#;
        let raw = format!(
            "Content-Length: {}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{}Content-Length: {}\r\n\r\n{}",
            a.len(),
            a,
            b.len(),
            b
        );
        let mut r = Cursor::new(raw.into_bytes());
        let first = read_frame(&mut r).unwrap().unwrap();
        assert_eq!(first["id"], 1);
        assert_eq!(first["result"]["ok"], true);
        let second = read_frame(&mut r).unwrap().unwrap();
        assert_eq!(second["params"]["x"], "é");
        assert!(read_frame(&mut r).unwrap().is_none(), "clean EOF");
    }
}
