//! acp-bridge: spawns ACP agent adapters (JSON-RPC 2.0 over stdio, newline-
//! delimited) and normalizes the protocol into one typed event stream.
//! Tauri-free so it can be tested headless against a fake scripted agent.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcpEvent {
    SessionReady { agent_id: u32, session_id: String },
    AgentText { agent_id: u32, text: String },
    AgentThought { agent_id: u32, text: String },
    /// tool_call and tool_call_update, passed through raw for the card UI (#6)
    ToolCall { agent_id: u32, update: Value },
    Plan { agent_id: u32, update: Value },
    PermissionRequest { agent_id: u32, request_id: Value, request: Value },
    TurnEnded { agent_id: u32, stop_reason: String },
    AgentExit { agent_id: u32, code: Option<i32> },
    Error { agent_id: u32, message: String },
}

#[derive(Clone, Debug, Deserialize)]
pub struct AgentConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Agent definitions live in a plain config file so the client stays
/// agent-agnostic: ~/.config/shorikai/agents.json
pub fn load_agent_config(name: &str) -> Result<AgentConfig, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = std::path::Path::new(&home).join(".config/shorikai");
    let path = dir.join("agents.json");
    if !path.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "agents": {
                    "claude-code": {
                        "command": "npx",
                        "args": ["--yes", "@zed-industries/claude-code-acp"]
                    }
                }
            }))
            .unwrap(),
        )
        .map_err(|e| e.to_string())?;
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let root: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("invalid {}: {e}", path.display()))?;
    let entry = root
        .get("agents")
        .and_then(|a| a.get(name))
        .ok_or_else(|| format!("agent {name:?} not found in {}", path.display()))?;
    serde_json::from_value(entry.clone()).map_err(|e| e.to_string())
}

struct AgentProc {
    child: Child,
    stdin: ChildStdin,
    next_rpc_id: u64,
    pending: HashMap<u64, mpsc::Sender<Result<Value, String>>>,
    session_id: Option<String>,
}

type Agents = Arc<Mutex<HashMap<u32, AgentProc>>>;

pub struct AcpBridge {
    agents: Agents,
    next_id: AtomicU32,
    on_event: Arc<dyn Fn(AcpEvent) + Send + Sync>,
}

impl AcpBridge {
    pub fn new(on_event: impl Fn(AcpEvent) + Send + Sync + 'static) -> Self {
        Self {
            agents: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU32::new(1),
            on_event: Arc::new(on_event),
        }
    }

    /// Spawn an agent adapter and run the ACP handshake (initialize +
    /// session/new with `cwd`) in the background; SessionReady or Error
    /// arrives on the event stream.
    pub fn start(&self, config: &AgentConfig, cwd: &str) -> Result<u32, String> {
        let mut child = Command::new(&config.command)
            .args(&config.args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to spawn {}: {e}", config.command))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let agent_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.agents.lock().unwrap().insert(
            agent_id,
            AgentProc {
                child,
                stdin,
                next_rpc_id: 0,
                pending: HashMap::new(),
                session_id: None,
            },
        );

        let agents = Arc::clone(&self.agents);
        let on_event = Arc::clone(&self.on_event);
        std::thread::spawn(move || read_loop(agent_id, stdout, agents, on_event));

        let agents = Arc::clone(&self.agents);
        let on_event = Arc::clone(&self.on_event);
        let cwd = cwd.to_owned();
        std::thread::spawn(move || {
            if let Err(message) = handshake(agent_id, &cwd, &agents) {
                on_event(AcpEvent::Error { agent_id, message });
            } else {
                let session_id = agents.lock().unwrap()[&agent_id]
                    .session_id
                    .clone()
                    .unwrap_or_default();
                on_event(AcpEvent::SessionReady { agent_id, session_id });
            }
        });

        Ok(agent_id)
    }

    /// Send a user prompt; TurnEnded is emitted when the agent finishes.
    pub fn prompt(&self, agent_id: u32, text: &str) -> Result<(), String> {
        let session_id = self
            .agents
            .lock()
            .unwrap()
            .get(&agent_id)
            .ok_or("no such agent")?
            .session_id
            .clone()
            .ok_or("session not ready")?;
        let rx = send_request(
            &self.agents,
            agent_id,
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }],
            }),
        )?;
        let on_event = Arc::clone(&self.on_event);
        std::thread::spawn(move || {
            match rx.recv() {
                Ok(Ok(result)) => {
                    let stop_reason = result
                        .get("stopReason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_owned();
                    on_event(AcpEvent::TurnEnded { agent_id, stop_reason });
                }
                Ok(Err(message)) => on_event(AcpEvent::Error { agent_id, message }),
                // channel closed: process exited, AgentExit already emitted
                Err(_) => {}
            }
        });
        Ok(())
    }

    /// Answer a session/request_permission from the agent.
    /// `option_id: None` means the user dismissed it (cancelled outcome).
    pub fn respond_permission(
        &self,
        agent_id: u32,
        request_id: Value,
        option_id: Option<String>,
    ) -> Result<(), String> {
        let outcome = match option_id {
            Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        };
        write_message(
            &self.agents,
            agent_id,
            json!({ "jsonrpc": "2.0", "id": request_id, "result": outcome }),
        )
    }

    pub fn cancel(&self, agent_id: u32) -> Result<(), String> {
        let session_id = self
            .agents
            .lock()
            .unwrap()
            .get(&agent_id)
            .and_then(|a| a.session_id.clone())
            .ok_or("no such agent")?;
        write_message(
            &self.agents,
            agent_id,
            json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": session_id },
            }),
        )
    }

    pub fn kill(&self, agent_id: u32) -> Result<(), String> {
        let mut agents = self.agents.lock().unwrap();
        let a = agents.get_mut(&agent_id).ok_or("no such agent")?;
        a.child.kill().map_err(|e| e.to_string())
    }

    /// See PtyHost::kill_all — reaps agents orphaned by a webview reload.
    pub fn kill_all(&self) {
        for a in self.agents.lock().unwrap().values_mut() {
            let _ = a.child.kill();
        }
    }
}

fn handshake(agent_id: u32, cwd: &str, agents: &Agents) -> Result<(), String> {
    // generous timeout: `npx` may download the adapter on first run
    const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);
    let recv = |rx: mpsc::Receiver<Result<Value, String>>| {
        rx.recv_timeout(HANDSHAKE_TIMEOUT)
            .map_err(|_| "agent did not answer the handshake".to_string())?
    };

    let rx = send_request(
        agents,
        agent_id,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "terminal": false,
            },
        }),
    )?;
    recv(rx)?;

    let rx = send_request(
        agents,
        agent_id,
        "session/new",
        json!({ "cwd": cwd, "mcpServers": [] }),
    )?;
    let result = recv(rx)?;
    let session_id = result
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or("session/new returned no sessionId")?
        .to_owned();
    if let Some(a) = agents.lock().unwrap().get_mut(&agent_id) {
        a.session_id = Some(session_id);
    }
    Ok(())
}

fn send_request(
    agents: &Agents,
    agent_id: u32,
    method: &str,
    params: Value,
) -> Result<mpsc::Receiver<Result<Value, String>>, String> {
    let (tx, rx) = mpsc::channel();
    let mut lock = agents.lock().unwrap();
    let a = lock.get_mut(&agent_id).ok_or("no such agent")?;
    let id = a.next_rpc_id;
    a.next_rpc_id += 1;
    a.pending.insert(id, tx);
    let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    writeln!(a.stdin, "{msg}").map_err(|e| e.to_string())?;
    Ok(rx)
}

fn write_message(agents: &Agents, agent_id: u32, msg: Value) -> Result<(), String> {
    let mut lock = agents.lock().unwrap();
    let a = lock.get_mut(&agent_id).ok_or("no such agent")?;
    writeln!(a.stdin, "{msg}").map_err(|e| e.to_string())
}

fn read_loop(
    agent_id: u32,
    stdout: std::process::ChildStdout,
    agents: Agents,
    on_event: Arc<dyn Fn(AcpEvent) + Send + Sync>,
) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle_message(agent_id, msg, &agents, &on_event),
            Err(e) => on_event(AcpEvent::Error {
                agent_id,
                message: format!("malformed message from agent: {e}"),
            }),
        }
    }
    // EOF: agent process is gone
    let code = agents.lock().unwrap().remove(&agent_id).and_then(|mut a| {
        a.child.wait().ok().and_then(|s| s.code())
    });
    on_event(AcpEvent::AgentExit { agent_id, code });
}

fn handle_message(
    agent_id: u32,
    msg: Value,
    agents: &Agents,
    on_event: &Arc<dyn Fn(AcpEvent) + Send + Sync>,
) {
    let method = msg.get("method").and_then(|m| m.as_str());

    // response to one of our requests
    if method.is_none() && msg.get("id").is_some() {
        let Some(id) = msg["id"].as_u64() else { return };
        let outcome = if let Some(err) = msg.get("error") {
            Err(err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("agent error")
                .to_owned())
        } else {
            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
        };
        if let Some(tx) = agents.lock().unwrap().get_mut(&agent_id).and_then(|a| a.pending.remove(&id)) {
            let _ = tx.send(outcome);
        }
        return;
    }

    match (method, msg.get("id")) {
        // request from the agent
        (Some("session/request_permission"), Some(id)) => on_event(AcpEvent::PermissionRequest {
            agent_id,
            request_id: id.clone(),
            request: msg.get("params").cloned().unwrap_or(Value::Null),
        }),
        (Some(m), Some(id)) => {
            // unknown request: answer so the agent never hangs on us
            let _ = write_message(
                agents,
                agent_id,
                json!({
                    "jsonrpc": "2.0",
                    "id": id.clone(),
                    "error": { "code": -32601, "message": format!("method not supported: {m}") },
                }),
            );
        }
        (Some("session/update"), None) => {
            let update = msg.pointer("/params/update").cloned().unwrap_or(Value::Null);
            match update.get("sessionUpdate").and_then(|k| k.as_str()) {
                Some("agent_message_chunk") => on_event(AcpEvent::AgentText {
                    agent_id,
                    text: chunk_text(&update),
                }),
                Some("agent_thought_chunk") => on_event(AcpEvent::AgentThought {
                    agent_id,
                    text: chunk_text(&update),
                }),
                Some("tool_call") | Some("tool_call_update") => {
                    on_event(AcpEvent::ToolCall { agent_id, update })
                }
                Some("plan") => on_event(AcpEvent::Plan { agent_id, update }),
                _ => {} // user_message_chunk, mode/commands updates: not needed yet
            }
        }
        _ => {} // other notifications: ignore
    }
}

fn chunk_text(update: &Value) -> String {
    update
        .pointer("/content/text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn fake_agent() -> AgentConfig {
        AgentConfig {
            command: "node".into(),
            args: vec![format!(
                "{}/tests/fake_acp_agent.mjs",
                env!("CARGO_MANIFEST_DIR")
            )],
        }
    }

    fn start_ready() -> (AcpBridge, mpsc::Receiver<AcpEvent>, u32) {
        let (tx, rx) = mpsc::channel();
        let bridge = AcpBridge::new(move |e| {
            tx.send(e).ok();
        });
        let id = bridge.start(&fake_agent(), "/tmp").unwrap();
        match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            AcpEvent::SessionReady { session_id, .. } => assert_eq!(session_id, "sess_fake"),
            other => panic!("expected SessionReady, got {other:?}"),
        }
        (bridge, rx, id)
    }

    fn drain_turn(rx: &mpsc::Receiver<AcpEvent>) -> (String, Vec<AcpEvent>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut text = String::new();
        let mut others = Vec::new();
        loop {
            let ev = rx
                .recv_timeout(deadline - Instant::now())
                .expect("turn never ended");
            match ev {
                AcpEvent::AgentText { text: t, .. } => text.push_str(&t),
                AcpEvent::TurnEnded { stop_reason, .. } => {
                    assert_eq!(stop_reason, "end_turn");
                    return (text, others);
                }
                other => others.push(other),
            }
        }
    }

    #[test]
    fn handshake_and_message_streaming() {
        let (bridge, rx, id) = start_ready();
        bridge.prompt(id, "hi").unwrap();
        let (text, others) = drain_turn(&rx);
        assert_eq!(text, "Hello world");
        assert!(others.is_empty(), "unexpected events: {others:?}");
        bridge.kill(id).unwrap();
        loop {
            match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                AcpEvent::AgentExit { agent_id, .. } => {
                    assert_eq!(agent_id, id);
                    break;
                }
                _ => {}
            }
        }
    }

    #[test]
    fn malformed_message_is_surfaced_and_survived() {
        let (bridge, rx, id) = start_ready();
        bridge.prompt(id, "garbage").unwrap();
        let (text, others) = drain_turn(&rx);
        assert_eq!(text, "Hello world");
        assert!(
            others
                .iter()
                .any(|e| matches!(e, AcpEvent::Error { message, .. } if message.contains("malformed"))),
            "no malformed-message error in {others:?}"
        );
        // bridge still works after the malformed line
        bridge.prompt(id, "hi").unwrap();
        let (text, _) = drain_turn(&rx);
        assert_eq!(text, "Hello world");
    }
}
