//! dap-core: generic DAP client over TCP with Content-Length framing (shared
//! with lsp-host). Manages the js-debug server lifecycle, the session tree
//! (child sessions arrive via reverse startDebugging requests), a breakpoint
//! store replayed into every session, and normalizes stops into typed events.
//! Adding debuggers later is config, not code: any DAP server over TCP works.

use crate::lsp_host::read_frame;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DapEvent {
    /// the adapter wants a terminal with these env vars (zero-attach hook)
    RunInTerminal {
        session_id: u32,
        request_seq: i64,
        title: String,
        cwd: String,
        env: HashMap<String, String>,
    },
    Stopped {
        session_id: u32,
        thread_id: i64,
        reason: String,
        path: Option<String>,
        line: Option<u32>,
    },
    Continued {
        session_id: u32,
    },
    Output {
        session_id: u32,
        category: String,
        text: String,
    },
    SessionEnded {
        session_id: u32,
    },
    Error {
        message: String,
    },
}

struct Session {
    writer: TcpStream,
    next_seq: AtomicI64,
    pending: Mutex<HashMap<i64, mpsc::Sender<Value>>>,
}

impl Session {
    fn send(&self, mut msg: Value) -> Result<i64, String> {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        msg["seq"] = json!(seq);
        let body = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        let mut w = &self.writer;
        write!(w, "Content-Length: {}\r\n\r\n", body.len())
            .and_then(|_| w.write_all(&body))
            .map_err(|e| e.to_string())?;
        Ok(seq)
    }

    fn request(&self, command: &str, args: Value) -> Result<mpsc::Receiver<Value>, String> {
        let (tx, rx) = mpsc::channel();
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        self.pending.lock().unwrap().insert(seq, tx);
        let msg = json!({ "seq": seq, "type": "request", "command": command, "arguments": args });
        let body = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        let mut w = &self.writer;
        write!(w, "Content-Length: {}\r\n\r\n", body.len())
            .and_then(|_| w.write_all(&body))
            .map_err(|e| e.to_string())?;
        Ok(rx)
    }

    /// fire-and-forget request: the response is dropped on arrival
    fn request_forget(&self, command: &str, args: Value) {
        let _ = self.send(json!({ "type": "request", "command": command, "arguments": args }));
    }

    fn respond(&self, request_seq: i64, command: &str, body: Value) {
        let _ = self.send(json!({
            "type": "response",
            "request_seq": request_seq,
            "success": true,
            "command": command,
            "body": body,
        }));
    }
}

type Sessions = Arc<Mutex<HashMap<u32, Arc<Session>>>>;

pub struct DapCore {
    server: Mutex<Option<(Child, u16)>>,
    sessions: Sessions,
    next_session: Arc<AtomicU32>,
    breakpoints: Arc<Mutex<HashMap<String, Vec<u32>>>>,
    on_event: Arc<dyn Fn(DapEvent) + Send + Sync>,
    /// pgids of per-session adapters (dlv); each has a reaper thread
    adapter_pids: Mutex<Vec<i32>>,
}

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

impl DapCore {
    pub fn new(on_event: impl Fn(DapEvent) + Send + Sync + 'static) -> Self {
        Self {
            server: Mutex::new(None),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_session: Arc::new(AtomicU32::new(1)),
            breakpoints: Arc::new(Mutex::new(HashMap::new())),
            on_event: Arc::new(on_event),
            adapter_pids: Mutex::new(Vec::new()),
        }
    }

    /// Launch a Go target under delve (dlv dap) and reuse the whole debug UI.
    /// Launch-based: Go has no NODE_OPTIONS-style attach trick.
    pub fn start_go_debug(
        &self,
        root: &str,
        program: &str,
        args: Vec<String>,
    ) -> Result<u32, String> {
        if !crate::lsp_host::which("dlv") {
            return Err(
                "delve (dlv) not found on PATH — go install github.com/go-delve/delve/cmd/dlv@latest"
                    .into(),
            );
        }
        let port = free_port()?;
        let mut child = Command::new("dlv")
            .args(["dap", "--listen", &format!("127.0.0.1:{port}")])
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("failed to start dlv: {e}"))?;
        let pid = child.id() as i32;

        // dlv dap serves exactly one client, so no readiness probe — a probe
        // connection would consume the slot. Retry the real session instead.
        let launch = json!({
            "type": "go",
            "request": "launch",
            "mode": "debug",
            "program": program,
            "args": args,
            "cwd": root,
            // debuggee stdout/stderr arrive as DAP output events
            "outputMode": "remote",
        });
        let mut last_err = String::new();
        for _ in 0..100 {
            if child.try_wait().map(|s| s.is_some()).unwrap_or(false) {
                return Err("dlv exited immediately".into());
            }
            match self.start_session(port, "launch", launch.clone()) {
                Ok(sid) => {
                    self.adapter_pids.lock().unwrap().push(pid);
                    // reaper: collects dlv when it exits (naturally or stop_all)
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                    return Ok(sid);
                }
                Err(e) if e.contains("refused") => {
                    last_err = e;
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => {
                    let _ = child.kill();
                    return Err(e);
                }
            }
        }
        let _ = child.kill();
        Err(format!("dlv dap did not start listening: {last_err}"))
    }

    /// Start (or reuse) the js-debug DAP server and open a debug-terminal
    /// session for `root`. Returns the parent session id; the terminal itself
    /// arrives as a RunInTerminal event.
    pub fn start_debug_terminal(&self, root: &str) -> Result<u32, String> {
        let port = self.ensure_js_debug()?;
        self.start_session(
            port,
            "launch",
            json!({
                "type": "node-terminal",
                "name": "Shorikai Debug Terminal",
                "request": "launch",
                "cwd": root,
            }),
        )
    }

    /// Connect a session to a DAP server, run the initialize handshake, then
    /// issue `request_command` (launch/attach). Used directly by tests with a
    /// mock adapter.
    pub fn start_session(
        &self,
        port: u16,
        request_command: &str,
        request_args: Value,
    ) -> Result<u32, String> {
        let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
        let session = Arc::new(Session {
            writer: stream.try_clone().map_err(|e| e.to_string())?,
            next_seq: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
        });
        let id = self.next_session.fetch_add(1, Ordering::Relaxed);
        self.sessions
            .lock()
            .unwrap()
            .insert(id, Arc::clone(&session));

        let ctx = ReaderCtx {
            session_id: id,
            port,
            session: Arc::clone(&session),
            sessions: Arc::clone(&self.sessions),
            breakpoints: Arc::clone(&self.breakpoints),
            on_event: Arc::clone(&self.on_event),
            next_session: Arc::clone(&self.next_session),
        };
        // reader thread owns the read half
        let reader_stream = stream;
        std::thread::spawn(move || reader_loop(reader_stream, ctx));

        let rx = session.request(
            "initialize",
            json!({
                "clientID": "shorikai",
                "clientName": "Shorikai",
                "adapterID": "shorikai",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsRunInTerminalRequest": true,
                "supportsStartDebuggingRequest": true,
            }),
        )?;
        rx.recv_timeout(REQUEST_TIMEOUT)
            .map_err(|_| "debug adapter did not answer initialize".to_string())?;

        // launch/attach completes asynchronously (js-debug waits on the
        // terminal); the response is not interesting here
        session.request_forget(request_command, request_args);
        Ok(id)
    }

    pub fn reply_run_in_terminal(
        &self,
        session_id: u32,
        request_seq: i64,
        shell_pid: Option<u32>,
    ) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(&session_id)
            .cloned()
            .ok_or("no such debug session")?;
        session.respond(
            request_seq,
            "runInTerminal",
            json!({ "shellProcessId": shell_pid }),
        );
        Ok(())
    }

    /// Full breakpoint list for one file; applied to every live session and
    /// replayed into future ones.
    pub fn set_breakpoints(&self, path: &str, lines: Vec<u32>) {
        {
            let mut bps = self.breakpoints.lock().unwrap();
            if lines.is_empty() {
                bps.remove(path);
            } else {
                bps.insert(path.to_owned(), lines.clone());
            }
        }
        let sessions = self.sessions.lock().unwrap();
        for session in sessions.values() {
            send_breakpoints(session, path, &lines);
        }
    }

    pub fn continue_(&self, session_id: u32, thread_id: i64) -> Result<(), String> {
        let session = self.session(session_id)?;
        session.request_forget("continue", json!({ "threadId": thread_id }));
        Ok(())
    }

    fn session(&self, session_id: u32) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "no such debug session".into())
    }

    fn request_sync(&self, session_id: u32, command: &str, args: Value) -> Result<Value, String> {
        let session = self.session(session_id)?;
        let rx = session.request(command, args)?;
        rx.recv_timeout(REQUEST_TIMEOUT)
            .map_err(|_| format!("debug adapter did not answer {command}"))
    }

    /// step kind: next | stepIn | stepOut | pause
    pub fn step(&self, session_id: u32, thread_id: i64, kind: &str) -> Result<(), String> {
        if !matches!(kind, "next" | "stepIn" | "stepOut" | "pause") {
            return Err(format!("unknown step kind {kind:?}"));
        }
        let session = self.session(session_id)?;
        session.request_forget(kind, json!({ "threadId": thread_id }));
        Ok(())
    }

    /// full stack, normalized to id/name/path/line per frame
    pub fn stack_trace(&self, session_id: u32, thread_id: i64) -> Result<Value, String> {
        let res = self.request_sync(
            session_id,
            "stackTrace",
            json!({ "threadId": thread_id, "startFrame": 0, "levels": 40 }),
        )?;
        let frames: Vec<Value> = res
            .pointer("/body/stackFrames")
            .and_then(|f| f.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|f| {
                        json!({
                            "id": f.get("id"),
                            "name": f.get("name"),
                            "path": f.pointer("/source/path"),
                            "line": f.get("line"),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Value::Array(frames))
    }

    pub fn scopes(&self, session_id: u32, frame_id: i64) -> Result<Value, String> {
        let res = self.request_sync(session_id, "scopes", json!({ "frameId": frame_id }))?;
        Ok(res.pointer("/body/scopes").cloned().unwrap_or(json!([])))
    }

    pub fn variables(&self, session_id: u32, variables_reference: i64) -> Result<Value, String> {
        let res = self.request_sync(
            session_id,
            "variables",
            json!({ "variablesReference": variables_reference }),
        )?;
        Ok(res.pointer("/body/variables").cloned().unwrap_or(json!([])))
    }

    pub fn evaluate(
        &self,
        session_id: u32,
        expression: &str,
        frame_id: Option<i64>,
    ) -> Result<Value, String> {
        let res = self.request_sync(
            session_id,
            "evaluate",
            json!({ "expression": expression, "frameId": frame_id, "context": "repl" }),
        )?;
        if res.get("success").and_then(|s| s.as_bool()) == Some(false) {
            return Err(res
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("evaluation failed")
                .to_owned());
        }
        Ok(res.get("body").cloned().unwrap_or(Value::Null))
    }

    pub fn stop_all(&self) {
        if let Some((mut child, _)) = self.server.lock().unwrap().take() {
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        for pid in self.adapter_pids.lock().unwrap().drain(..) {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        self.sessions.lock().unwrap().clear();
    }

    /* ---------- js-debug provisioning ---------- */

    fn ensure_js_debug(&self) -> Result<u16, String> {
        let mut server = self.server.lock().unwrap();
        if let Some((child, port)) = server.as_mut() {
            if child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
                return Ok(*port);
            }
            *server = None;
        }
        let entry = js_debug_entrypoint()?;
        let port = free_port()?;
        let child = Command::new("node")
            .arg(&entry)
            .arg(port.to_string())
            .arg("127.0.0.1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("failed to start js-debug: {e}"))?;
        // wait until it accepts connections
        for _ in 0..100 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                *server = Some((child, port));
                return Ok(port);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("js-debug server did not come up".into())
    }
}

const JS_DEBUG_VERSION: &str = "1.117.0";

/// Locate dapDebugServer.js under ~/.config/shorikai/js-debug, downloading
/// the official release tarball on first use.
fn js_debug_entrypoint() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = std::path::Path::new(&home).join(".config/shorikai/js-debug");
    if let Some(found) = find_file(&dir, "dapDebugServer.js", 4) {
        return Ok(found);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let url = format!(
        "https://github.com/microsoft/vscode-js-debug/releases/download/v{v}/js-debug-dap-v{v}.tar.gz",
        v = JS_DEBUG_VERSION
    );
    let status = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "curl -fsSL '{url}' | tar xz -C '{}'",
            dir.display()
        ))
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "failed to download js-debug — install manually: curl -L {url} | tar xz -C {}",
            dir.display()
        ));
    }
    find_file(&dir, "dapDebugServer.js", 4).ok_or("js-debug download had unexpected layout".into())
}

fn find_file(dir: &std::path::Path, name: &str, depth: u8) -> Option<std::path::PathBuf> {
    if depth == 0 {
        return None;
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if entry.file_name() == name {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file(&path, name, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

/* ---------- reader ---------- */

struct ReaderCtx {
    session_id: u32,
    port: u16,
    session: Arc<Session>,
    sessions: Sessions,
    breakpoints: Arc<Mutex<HashMap<String, Vec<u32>>>>,
    on_event: Arc<dyn Fn(DapEvent) + Send + Sync>,
    next_session: Arc<AtomicU32>,
}

fn send_breakpoints(session: &Session, path: &str, lines: &[u32]) {
    session.request_forget(
        "setBreakpoints",
        json!({
            "source": { "path": path },
            "breakpoints": lines.iter().map(|l| json!({ "line": l })).collect::<Vec<_>>(),
        }),
    );
}

fn reader_loop(stream: TcpStream, ctx: ReaderCtx) {
    let mut reader = BufReader::new(stream);
    while let Ok(Some(msg)) = read_frame(&mut reader) {
        handle_message(&ctx, msg);
    }
    ctx.sessions.lock().unwrap().remove(&ctx.session_id);
    (ctx.on_event)(DapEvent::SessionEnded {
        session_id: ctx.session_id,
    });
}

fn handle_message(ctx: &ReaderCtx, msg: Value) {
    match msg.get("type").and_then(|t| t.as_str()) {
        Some("response") => {
            let Some(seq) = msg.get("request_seq").and_then(|s| s.as_i64()) else {
                return;
            };
            if let Some(tx) = ctx.session.pending.lock().unwrap().remove(&seq) {
                let _ = tx.send(msg);
            }
        }
        Some("event") => handle_event(ctx, &msg),
        Some("request") => handle_reverse_request(ctx, &msg),
        _ => {}
    }
}

fn handle_event(ctx: &ReaderCtx, msg: &Value) {
    let body = msg.get("body").cloned().unwrap_or(Value::Null);
    match msg.get("event").and_then(|e| e.as_str()) {
        Some("initialized") => {
            // apply the breakpoint store, then let the session run
            let session = Arc::clone(&ctx.session);
            let bps = ctx.breakpoints.lock().unwrap().clone();
            std::thread::spawn(move || {
                for (path, lines) in &bps {
                    send_breakpoints(&session, path, lines);
                }
                session.request_forget("configurationDone", json!({}));
            });
        }
        Some("stopped") => {
            let session = Arc::clone(&ctx.session);
            let on_event = Arc::clone(&ctx.on_event);
            let session_id = ctx.session_id;
            let thread_id = body.get("threadId").and_then(|t| t.as_i64()).unwrap_or(1);
            let reason = body
                .get("reason")
                .and_then(|r| r.as_str())
                .unwrap_or("stopped")
                .to_owned();
            std::thread::spawn(move || {
                let frame = session
                    .request(
                        "stackTrace",
                        json!({ "threadId": thread_id, "startFrame": 0, "levels": 1 }),
                    )
                    .ok()
                    .and_then(|rx| rx.recv_timeout(REQUEST_TIMEOUT).ok());
                let top = frame
                    .as_ref()
                    .and_then(|f| f.pointer("/body/stackFrames/0").cloned())
                    .unwrap_or(Value::Null);
                on_event(DapEvent::Stopped {
                    session_id,
                    thread_id,
                    reason,
                    path: top
                        .pointer("/source/path")
                        .and_then(|p| p.as_str())
                        .map(str::to_owned),
                    line: top.get("line").and_then(|l| l.as_u64()).map(|l| l as u32),
                });
            });
        }
        Some("continued") => (ctx.on_event)(DapEvent::Continued {
            session_id: ctx.session_id,
        }),
        Some("terminated") => {
            // the debuggee is done; disconnect so the adapter closes the
            // socket (dlv in particular waits for this before exiting)
            ctx.session.request_forget("disconnect", json!({}));
        }
        Some("output") => (ctx.on_event)(DapEvent::Output {
            session_id: ctx.session_id,
            category: body
                .get("category")
                .and_then(|c| c.as_str())
                .unwrap_or("console")
                .to_owned(),
            text: body
                .get("output")
                .and_then(|o| o.as_str())
                .unwrap_or_default()
                .to_owned(),
        }),
        _ => {}
    }
}

fn handle_reverse_request(ctx: &ReaderCtx, msg: &Value) {
    let seq = msg.get("seq").and_then(|s| s.as_i64()).unwrap_or(0);
    let command = msg.get("command").and_then(|c| c.as_str()).unwrap_or("");
    let args = msg.get("arguments").cloned().unwrap_or(Value::Null);
    match command {
        "runInTerminal" => {
            let env = args
                .get("env")
                .and_then(|e| e.as_object())
                .map(|o| {
                    o.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                        .collect()
                })
                .unwrap_or_default();
            (ctx.on_event)(DapEvent::RunInTerminal {
                session_id: ctx.session_id,
                request_seq: seq,
                title: args
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("debug")
                    .to_owned(),
                cwd: args
                    .get("cwd")
                    .and_then(|c| c.as_str())
                    .unwrap_or_default()
                    .to_owned(),
                env,
            });
            // the frontend answers via reply_run_in_terminal
        }
        "startDebugging" => {
            // child session: connect back to the same server and attach
            ctx.session.respond(seq, "startDebugging", json!({}));
            let port = ctx.port;
            let sessions = Arc::clone(&ctx.sessions);
            let breakpoints = Arc::clone(&ctx.breakpoints);
            let on_event = Arc::clone(&ctx.on_event);
            let next_session = Arc::clone(&ctx.next_session);
            std::thread::spawn(move || {
                let request = args
                    .get("request")
                    .and_then(|r| r.as_str())
                    .unwrap_or("attach")
                    .to_owned();
                let config = args.get("configuration").cloned().unwrap_or(json!({}));
                if let Err(e) = start_child_session(
                    port,
                    &request,
                    config,
                    &next_session,
                    sessions,
                    breakpoints,
                    on_event.clone(),
                ) {
                    on_event(DapEvent::Error { message: e });
                }
            });
        }
        _ => ctx.session.respond(seq, command, json!({})),
    }
}

fn start_child_session(
    port: u16,
    request_command: &str,
    request_args: Value,
    next_session: &Arc<AtomicU32>,
    sessions: Sessions,
    breakpoints: Arc<Mutex<HashMap<String, Vec<u32>>>>,
    on_event: Arc<dyn Fn(DapEvent) + Send + Sync>,
) -> Result<u32, String> {
    let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    let session = Arc::new(Session {
        writer: stream.try_clone().map_err(|e| e.to_string())?,
        next_seq: AtomicI64::new(1),
        pending: Mutex::new(HashMap::new()),
    });
    let id = next_session.fetch_add(1, Ordering::Relaxed);
    sessions.lock().unwrap().insert(id, Arc::clone(&session));

    let ctx = ReaderCtx {
        session_id: id,
        port,
        session: Arc::clone(&session),
        sessions,
        breakpoints,
        on_event,
        next_session: Arc::clone(next_session),
    };
    std::thread::spawn(move || reader_loop(stream, ctx));

    let rx = session.request(
        "initialize",
        json!({
            "clientID": "shorikai",
            "adapterID": "shorikai",
            "linesStartAt1": true,
            "columnsStartAt1": true,
            "pathFormat": "path",
            "supportsRunInTerminalRequest": true,
            "supportsStartDebuggingRequest": true,
        }),
    )?;
    rx.recv_timeout(REQUEST_TIMEOUT)
        .map_err(|_| "child session initialize timed out".to_string())?;
    session.request_forget(request_command, request_args);
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn spawn_fake_adapter() -> (Child, u16) {
        let port = free_port().unwrap();
        let mut child = Command::new("node")
            .arg(format!(
                "{}/tests/fake_dap_server.mjs",
                env!("CARGO_MANIFEST_DIR")
            ))
            .arg(port.to_string())
            .spawn()
            .unwrap();
        for _ in 0..100 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                return (child, port);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        panic!("fake adapter never came up");
    }

    #[test]
    fn handshake_breakpoint_stop_continue() {
        let (mut adapter, port) = spawn_fake_adapter();
        let (tx, rx) = mpsc::channel();
        let core = DapCore::new(move |e| {
            tx.send(e).ok();
        });

        core.set_breakpoints("/tmp/fake/app.js", vec![7]);
        let sid = core
            .start_session(
                port,
                "launch",
                json!({ "type": "fake", "request": "launch" }),
            )
            .unwrap();

        // fake adapter stops at the breakpoint only after it saw
        // setBreakpoints for line 7 followed by configurationDone
        let deadline = Instant::now() + Duration::from_secs(10);
        let (thread_id, path, line) = loop {
            match rx.recv_timeout(deadline - Instant::now()).expect("no stop") {
                DapEvent::Stopped {
                    thread_id,
                    path,
                    line,
                    reason,
                    ..
                } => {
                    assert_eq!(reason, "breakpoint");
                    break (thread_id, path, line);
                }
                DapEvent::Error { message } => panic!("error: {message}"),
                _ => {}
            }
        };
        assert_eq!(path.as_deref(), Some("/tmp/fake/app.js"));
        assert_eq!(line, Some(7));

        core.continue_(sid, thread_id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let DapEvent::Continued { session_id } = rx
                .recv_timeout(deadline - Instant::now())
                .expect("no continue")
            {
                assert_eq!(session_id, sid);
                break;
            }
        }
        let _ = adapter.kill();
    }

    fn wait_stop(rx: &mpsc::Receiver<DapEvent>) -> i64 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match rx.recv_timeout(deadline - Instant::now()).expect("no stop") {
                DapEvent::Stopped { thread_id, .. } => return thread_id,
                DapEvent::Error { message } => panic!("error: {message}"),
                _ => {}
            }
        }
    }

    #[test]
    fn step_stack_variables_evaluate_round_trip() {
        let (mut adapter, port) = spawn_fake_adapter();
        let (tx, rx) = mpsc::channel();
        let core = DapCore::new(move |e| {
            tx.send(e).ok();
        });
        core.set_breakpoints("/tmp/fake/app.js", vec![7]);
        let sid = core
            .start_session(port, "launch", json!({ "type": "fake" }))
            .unwrap();
        let thread = wait_stop(&rx);

        let frames = core.stack_trace(sid, thread).unwrap();
        assert_eq!(frames[0]["path"], "/tmp/fake/app.js");
        assert_eq!(frames[1]["name"], "caller");
        assert_eq!(frames[1]["line"], 21);

        let scopes = core.scopes(sid, frames[0]["id"].as_i64().unwrap()).unwrap();
        assert_eq!(scopes[0]["name"], "Locals");
        let vars = core
            .variables(sid, scopes[0]["variablesReference"].as_i64().unwrap())
            .unwrap();
        assert_eq!(vars[0]["name"], "x");
        assert_eq!(vars[0]["value"], "42");
        // nested expansion
        let nested = core
            .variables(sid, vars[1]["variablesReference"].as_i64().unwrap())
            .unwrap();
        assert_eq!(nested[0]["name"], "y");

        let eval = core.evaluate(sid, "1+1", Some(1)).unwrap();
        assert_eq!(eval["result"], "=1+1");

        // step over: continued, then stopped again
        core.step(sid, thread, "next").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let DapEvent::Continued { .. } = rx
                .recv_timeout(deadline - Instant::now())
                .expect("no continued")
            {
                break;
            }
        }
        wait_stop(&rx);
        let _ = adapter.kill();
    }

    #[test]
    fn go_debug_end_to_end_with_delve() {
        if !crate::lsp_host::which("dlv") || !crate::lsp_host::which("go") {
            eprintln!("skipping: dlv/go not on PATH");
            return;
        }
        let dir = std::env::temp_dir().join(format!("shorikai-godbg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // /var/folders is a symlink; go records canonical /private/var paths
        let dir = std::fs::canonicalize(&dir).unwrap();
        std::fs::write(dir.join("go.mod"), "module fake\n\ngo 1.21\n").unwrap();
        std::fs::write(
            dir.join("main.go"),
            "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tx := 41\n\tx = x + 1\n\tfmt.Println(\"x =\", x)\n}\n",
        )
        .unwrap();
        let root = dir.to_str().unwrap();
        let main_go = dir.join("main.go").to_string_lossy().into_owned();

        let (tx, rx) = mpsc::channel();
        let core = DapCore::new(move |e| {
            tx.send(e).ok();
        });
        core.set_breakpoints(&main_go, vec![7]); // x = x + 1
        let sid = core.start_go_debug(root, ".", vec![]).unwrap();

        // dlv compiles the target first; be generous
        let deadline = Instant::now() + Duration::from_secs(90);
        let thread = loop {
            match rx.recv_timeout(deadline - Instant::now()).expect("no stop") {
                DapEvent::Stopped {
                    thread_id,
                    path,
                    line,
                    ..
                } => {
                    assert!(
                        path.as_deref().unwrap_or("").ends_with("main.go"),
                        "{path:?}"
                    );
                    assert_eq!(line, Some(7));
                    break thread_id;
                }
                DapEvent::Error { message } => panic!("error: {message}"),
                _ => {}
            }
        };

        // unchanged instruments work on Go
        let frames = core.stack_trace(sid, thread).unwrap();
        assert!(frames[0]["path"].as_str().unwrap().ends_with("main.go"));
        let scopes = core.scopes(sid, frames[0]["id"].as_i64().unwrap()).unwrap();
        let vars = core
            .variables(sid, scopes[0]["variablesReference"].as_i64().unwrap())
            .unwrap();
        let x = vars
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "x")
            .expect("local x");
        assert_eq!(x["value"], "41");

        core.continue_(sid, thread).unwrap();
        // program stdout arrives as output events, session ends when dlv exits
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut saw_output = false;
        loop {
            match rx.recv_timeout(deadline - Instant::now()).expect("no end") {
                DapEvent::Output { text, .. } if text.contains("x = 42") => saw_output = true,
                DapEvent::SessionEnded { .. } => break,
                _ => {}
            }
        }
        assert!(
            saw_output,
            "program stdout should stream through as output events"
        );
        core.stop_all();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn adapter_crash_ends_session() {
        let (mut adapter, port) = spawn_fake_adapter();
        let (tx, rx) = mpsc::channel();
        let core = DapCore::new(move |e| {
            tx.send(e).ok();
        });
        core.set_breakpoints("/tmp/fake/app.js", vec![7]);
        let sid = core
            .start_session(port, "launch", json!({ "type": "fake" }))
            .unwrap();
        wait_stop(&rx);

        adapter.kill().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let DapEvent::SessionEnded { session_id } = rx
                .recv_timeout(deadline - Instant::now())
                .expect("no session end")
            {
                assert_eq!(session_id, sid);
                break;
            }
        }
        assert!(
            core.stack_trace(sid, 1).is_err(),
            "dead session must error, not hang"
        );
    }
}
