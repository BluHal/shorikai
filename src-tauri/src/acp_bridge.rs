//! acp-bridge: spawns ACP agent adapters (JSON-RPC 2.0 over stdio, newline-
//! delimited) and normalizes the protocol into one typed event stream.
//! Tauri-free so it can be tested headless against a fake scripted agent.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcpEvent {
    SessionReady {
        agent_id: u32,
        session_id: String,
    },
    AgentText {
        agent_id: u32,
        text: String,
    },
    AgentThought {
        agent_id: u32,
        text: String,
    },
    /// user messages replayed by session/load
    UserText {
        agent_id: u32,
        text: String,
    },
    /// tool_call and tool_call_update, passed through raw for the card UI (#6)
    ToolCall {
        agent_id: u32,
        update: Value,
    },
    Plan {
        agent_id: u32,
        update: Value,
    },
    /// Task tool calls normalized into sub-agent state; full state per event
    /// so the frontend just replaces by id
    SubAgentUpdate {
        agent_id: u32,
        sub: SubAgentState,
    },
    /// modes/models offered by the agent (from session/new), plus
    /// currentModeId-only updates when the agent switches mode itself
    ConfigOptions {
        agent_id: u32,
        options: Value,
    },
    /// slash commands advertised via available_commands_update
    AvailableCommands {
        agent_id: u32,
        commands: Value,
    },
    PermissionRequest {
        agent_id: u32,
        request_id: Value,
        request: Value,
    },
    TurnEnded {
        agent_id: u32,
        stop_reason: String,
    },
    AgentExit {
        agent_id: u32,
        code: Option<i32>,
    },
    Error {
        agent_id: u32,
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct SubAgentState {
    pub id: String,
    pub name: String,
    pub task: String,
    /// working | done | failed
    pub status: String,
    /// last text line the sub-agent produced
    pub activity: String,
    /// accumulated text chunks; may stay empty for shallow streams
    pub transcript: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AgentConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

fn default_agents() -> Value {
    json!({
        "claude-code": {
            "command": "npx",
            "args": ["--yes", "@zed-industries/claude-code-acp"]
        },
        "codex": {
            "command": "npx",
            "args": ["--yes", "@zed-industries/codex-acp"],
            "fallback": "codex"
        }
    })
}

/// Agent definitions live in a plain config file so the client stays
/// agent-agnostic: ~/.config/shorikai/agents.json. Missing default entries
/// are merged in additively; user edits win.
pub fn load_agents() -> Result<Value, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = std::path::Path::new(&home).join(".config/shorikai");
    let path = dir.join("agents.json");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut root: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({ "agents": {} }));
    let mut changed = !path.exists();
    if !root.get("agents").map(Value::is_object).unwrap_or(false) {
        root["agents"] = json!({});
        changed = true;
    }
    let agents = root["agents"].as_object_mut().unwrap();
    for (name, cfg) in default_agents().as_object().unwrap() {
        if !agents.contains_key(name) {
            agents.insert(name.clone(), cfg.clone());
            changed = true;
        }
    }
    if changed {
        std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap())
            .map_err(|e| e.to_string())?;
    }
    Ok(root["agents"].clone())
}

pub fn load_agent_config(name: &str) -> Result<AgentConfig, String> {
    let agents = load_agents()?;
    let entry = agents
        .get(name)
        .ok_or_else(|| format!("agent {name:?} not found in agents.json"))?;
    serde_json::from_value(entry.clone()).map_err(|e| e.to_string())
}

struct AgentProc {
    child: Child,
    stdin: ChildStdin,
    next_rpc_id: u64,
    pending: HashMap<u64, mpsc::Sender<Result<Value, String>>>,
    session_id: Option<String>,
    subagents: HashMap<String, SubAgentState>,
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
    /// session/new with `cwd`, or session/load when `resume` names a past
    /// session) in the background; SessionReady or Error arrives on the
    /// event stream. `meta` is passed as `_meta` (e.g. claude-code adapter
    /// options like effort). A resumed session replays its history as
    /// UserText/AgentText events before SessionReady.
    pub fn start(
        &self,
        config: &AgentConfig,
        cwd: &str,
        meta: Option<Value>,
        resume: Option<String>,
    ) -> Result<u32, String> {
        let mut child = Command::new(&config.command)
            .args(&config.args)
            .current_dir(cwd)
            .envs(&config.env)
            // shed any enclosing Claude Code session (e.g. when Shorikai is
            // launched from a Claude Code dev loop), or the agent refuses to run
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_SSE_PORT")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            // own process group, so kill() reaches wrapper-spawned
            // grandchildren (npx -> node adapter) and EOF/reap still fire
            .process_group(0)
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
                subagents: HashMap::new(),
            },
        );

        let agents = Arc::clone(&self.agents);
        let on_event = Arc::clone(&self.on_event);
        std::thread::spawn(move || read_loop(agent_id, stdout, agents, on_event));

        let agents = Arc::clone(&self.agents);
        let on_event = Arc::clone(&self.on_event);
        let cwd = cwd.to_owned();
        std::thread::spawn(
            move || match handshake(agent_id, &cwd, meta, resume, &agents) {
                Err(message) => on_event(AcpEvent::Error { agent_id, message }),
                Ok(result) => {
                    let session_id = result
                        .get("sessionId")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_owned();
                    on_event(AcpEvent::SessionReady {
                        agent_id,
                        session_id,
                    });
                    let mut options = serde_json::Map::new();
                    for key in ["modes", "models", "configOptions"] {
                        if let Some(v) = result.get(key).filter(|v| !v.is_null()) {
                            options.insert(key.into(), v.clone());
                        }
                    }
                    if !options.is_empty() {
                        on_event(AcpEvent::ConfigOptions {
                            agent_id,
                            options: options.into(),
                        });
                    }
                }
            },
        );

        Ok(agent_id)
    }

    fn session_id(&self, agent_id: u32) -> Result<String, String> {
        self.agents
            .lock()
            .unwrap()
            .get(&agent_id)
            .ok_or_else(|| "no such agent".to_string())?
            .session_id
            .clone()
            .ok_or_else(|| "session not ready".to_string())
    }

    /// Send a plain-text user prompt; TurnEnded is emitted when the agent
    /// finishes.
    pub fn prompt(&self, agent_id: u32, text: &str) -> Result<(), String> {
        self.prompt_blocks(agent_id, json!([{ "type": "text", "text": text }]))
    }

    /// Send a prompt as raw ACP content blocks (text, resource_link, image…).
    pub fn prompt_blocks(&self, agent_id: u32, prompt: Value) -> Result<(), String> {
        let session_id = self.session_id(agent_id)?;
        let rx = send_request(
            &self.agents,
            agent_id,
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": prompt }),
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
                    on_event(AcpEvent::TurnEnded {
                        agent_id,
                        stop_reason,
                    });
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

    /// Fire-and-forget session/set_mode; the agent confirms with a
    /// current_mode_update, which comes back as another ConfigOptions event.
    pub fn set_mode(&self, agent_id: u32, mode_id: &str) -> Result<(), String> {
        let session_id = self.session_id(agent_id)?;
        send_request(
            &self.agents,
            agent_id,
            "session/set_mode",
            json!({ "sessionId": session_id, "modeId": mode_id }),
        )
        .map(drop)
    }

    pub fn set_model(&self, agent_id: u32, model_id: &str) -> Result<(), String> {
        let session_id = self.session_id(agent_id)?;
        send_request(
            &self.agents,
            agent_id,
            "session/set_model",
            json!({ "sessionId": session_id, "modelId": model_id }),
        )
        .map(drop)
    }

    pub fn set_config_option(
        &self,
        agent_id: u32,
        config_id: &str,
        value: &str,
    ) -> Result<(), String> {
        let session_id = self.session_id(agent_id)?;
        send_request(
            &self.agents,
            agent_id,
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": config_id, "value": value }),
        )
        .map(drop)
    }

    pub fn cancel(&self, agent_id: u32) -> Result<(), String> {
        let session_id = self.session_id(agent_id)?;
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
        kill_group(&mut a.child);
        Ok(())
    }

    /// See PtyHost::kill_all — reaps agents orphaned by a webview reload.
    pub fn kill_all(&self) {
        for a in self.agents.lock().unwrap().values_mut() {
            kill_group(&mut a.child);
        }
    }
}

fn kill_group(child: &mut Child) {
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill(); // in case the group was already gone
}

/// Runs initialize + session/new; returns the session/new result so the
/// caller can surface modes/models.
fn handshake(
    agent_id: u32,
    cwd: &str,
    meta: Option<Value>,
    resume: Option<String>,
    agents: &Agents,
) -> Result<Value, String> {
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

    let mut params = json!({ "cwd": cwd, "mcpServers": [] });
    if let Some(m) = meta {
        params["_meta"] = m;
    }
    let (method, session_id) = if let Some(id) = resume {
        params["sessionId"] = Value::String(id.clone());
        ("session/load", id)
    } else {
        ("session/new", String::new())
    };
    let rx = send_request(agents, agent_id, method, params)?;
    let mut result = recv(rx)?;
    let session_id = if method == "session/new" {
        result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or("session/new returned no sessionId")?
            .to_owned()
    } else {
        result["sessionId"] = Value::String(session_id.clone());
        session_id
    };
    if let Some(a) = agents.lock().unwrap().get_mut(&agent_id) {
        a.session_id = Some(session_id);
    }
    Ok(result)
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
    let code = agents
        .lock()
        .unwrap()
        .remove(&agent_id)
        .and_then(|mut a| a.child.wait().ok().and_then(|s| s.code()));
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
        if let Some(tx) = agents
            .lock()
            .unwrap()
            .get_mut(&agent_id)
            .and_then(|a| a.pending.remove(&id))
        {
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
            let update = msg
                .pointer("/params/update")
                .cloned()
                .unwrap_or(Value::Null);
            match update.get("sessionUpdate").and_then(|k| k.as_str()) {
                Some("agent_message_chunk") => on_event(AcpEvent::AgentText {
                    agent_id,
                    text: chunk_text(&update),
                }),
                Some("agent_thought_chunk") => on_event(AcpEvent::AgentThought {
                    agent_id,
                    text: chunk_text(&update),
                }),
                Some("user_message_chunk") => on_event(AcpEvent::UserText {
                    agent_id,
                    text: chunk_text(&update),
                }),
                Some("tool_call") | Some("tool_call_update") => {
                    match track_subagent(agent_id, &update, agents) {
                        Some(sub) => on_event(AcpEvent::SubAgentUpdate { agent_id, sub }),
                        None => on_event(AcpEvent::ToolCall { agent_id, update }),
                    }
                }
                Some("plan") => on_event(AcpEvent::Plan { agent_id, update }),
                Some("current_mode_update") => on_event(AcpEvent::ConfigOptions {
                    agent_id,
                    options: json!({ "currentModeId": update.get("currentModeId") }),
                }),
                Some("config_option_update") => on_event(AcpEvent::ConfigOptions {
                    agent_id,
                    options: json!({ "configOptions": update.get("configOptions") }),
                }),
                Some("available_commands_update") => on_event(AcpEvent::AvailableCommands {
                    agent_id,
                    commands: update
                        .get("availableCommands")
                        .cloned()
                        .unwrap_or(Value::Null),
                }),
                _ => {} // user_message_chunk: not needed yet
            }
        }
        _ => {} // other notifications: ignore
    }
}

/// Recognize Task tool calls (Claude Code sub-agents) and fold their updates
/// into per-sub-agent state. Returns the fresh state when `update` belongs to
/// a sub-agent, None when it is an ordinary tool call.
fn track_subagent(agent_id: u32, update: &Value, agents: &Agents) -> Option<SubAgentState> {
    let id = update.get("toolCallId")?.as_str()?;
    let mut lock = agents.lock().unwrap();
    let a = lock.get_mut(&agent_id)?;

    if update["sessionUpdate"] == "tool_call" && !a.subagents.contains_key(id) {
        let raw = update.get("rawInput");
        let subtype = raw
            .and_then(|r| r.get("subagent_type"))
            .and_then(|v| v.as_str());
        let title = update.get("title").and_then(|t| t.as_str()).unwrap_or("");
        if subtype.is_none() && !title.starts_with("Task") {
            return None;
        }
        let task = raw
            .and_then(|r| r.get("description"))
            .and_then(|v| v.as_str())
            .or_else(|| {
                raw.and_then(|r| r.get("prompt"))
                    .and_then(|v| v.as_str())
                    .map(|p| p.lines().next().unwrap_or(p))
            })
            .unwrap_or(title)
            .to_owned();
        let sub = SubAgentState {
            id: id.to_owned(),
            name: subtype.unwrap_or("sub-agent").to_owned(),
            task,
            status: "working".into(),
            activity: String::new(),
            transcript: Vec::new(),
        };
        a.subagents.insert(id.to_owned(), sub.clone());
        return Some(sub);
    }

    let sub = a.subagents.get_mut(id)?;
    if let Some(items) = update.get("content").and_then(|c| c.as_array()) {
        for item in items {
            if let Some(text) = item.pointer("/content/text").and_then(|t| t.as_str()) {
                sub.transcript.push(text.to_owned());
                sub.activity = text.trim_end().lines().last().unwrap_or(text).to_owned();
            }
        }
    }
    if let Some(status) = update.get("status").and_then(|s| s.as_str()) {
        sub.status = match status {
            "completed" => "done",
            "failed" => "failed",
            _ => "working",
        }
        .into();
    }
    Some(sub.clone())
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
            env: HashMap::new(),
        }
    }

    fn start_ready() -> (AcpBridge, mpsc::Receiver<AcpEvent>, u32) {
        let (tx, rx) = mpsc::channel();
        let bridge = AcpBridge::new(move |e| {
            tx.send(e).ok();
        });
        let id = bridge.start(&fake_agent(), "/tmp", None, None).unwrap();
        match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            AcpEvent::SessionReady { session_id, .. } => assert_eq!(session_id, "sess_fake"),
            other => panic!("expected SessionReady, got {other:?}"),
        }
        // fake agent always advertises modes + models after session/new
        match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            AcpEvent::ConfigOptions { options, .. } => {
                assert_eq!(options.pointer("/modes/currentModeId").unwrap(), "default");
                assert_eq!(
                    options
                        .pointer("/models/availableModels/1/modelId")
                        .unwrap(),
                    "opus"
                );
            }
            other => panic!("expected ConfigOptions, got {other:?}"),
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
    fn tool_call_and_diff_normalization() {
        let (bridge, rx, id) = start_ready();
        bridge.prompt(id, "tools").unwrap();
        let (text, others) = drain_turn(&rx);
        assert_eq!(text, "done");

        let updates: Vec<&Value> = others
            .iter()
            .filter_map(|e| match e {
                AcpEvent::ToolCall { update, .. } => Some(update),
                _ => None,
            })
            .collect();
        assert_eq!(updates.len(), 4, "expected 4 tool events: {others:?}");

        assert_eq!(updates[0]["sessionUpdate"], "tool_call");
        assert_eq!(updates[0]["toolCallId"], "call_1");
        assert_eq!(updates[0]["kind"], "read");
        assert_eq!(updates[0]["status"], "in_progress");

        assert_eq!(updates[1]["sessionUpdate"], "tool_call_update");
        assert_eq!(updates[1]["status"], "completed");
        assert_eq!(
            updates[1].pointer("/content/0/content/text").unwrap(),
            "{ \"name\": \"demo\" }"
        );

        assert_eq!(updates[2]["kind"], "edit");
        assert_eq!(updates[2].pointer("/content/0/type").unwrap(), "diff");
        assert_eq!(
            updates[2].pointer("/content/0/oldText").unwrap(),
            "const a = 1;\n"
        );
        assert_eq!(
            updates[2].pointer("/content/0/newText").unwrap(),
            "const a = 2;\n"
        );
    }

    #[test]
    fn permission_round_trip() {
        let (bridge, rx, id) = start_ready();
        bridge.prompt(id, "permission").unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let (request_id, request) = loop {
            match rx.recv_timeout(deadline - Instant::now()).unwrap() {
                AcpEvent::PermissionRequest {
                    request_id,
                    request,
                    ..
                } => break (request_id, request),
                _ => {}
            }
        };
        assert_eq!(request.pointer("/toolCall/title").unwrap(), "Run npm test");
        assert_eq!(request.pointer("/options/0/optionId").unwrap(), "allow");

        bridge
            .respond_permission(id, request_id, Some("allow".into()))
            .unwrap();
        let (text, _) = drain_turn(&rx);
        assert_eq!(
            text, "approved:allow",
            "agent did not proceed after approval"
        );
    }

    #[test]
    fn two_subagent_scenario() {
        let (bridge, rx, id) = start_ready();
        bridge.prompt(id, "team").unwrap();
        let (text, others) = drain_turn(&rx);
        assert_eq!(text, "merged");

        let subs: Vec<&SubAgentState> = others
            .iter()
            .filter_map(|e| match e {
                AcpEvent::SubAgentUpdate { sub, .. } => Some(sub),
                _ => None,
            })
            .collect();
        assert_eq!(subs.len(), 5, "expected 5 sub-agent updates: {others:?}");
        assert!(
            !others
                .iter()
                .any(|e| matches!(e, AcpEvent::ToolCall { .. })),
            "Task calls must not leak as plain tool calls: {others:?}"
        );

        // spawn moment: both created as working, with task one-liners
        assert_eq!(subs[0].name, "fe-agent");
        assert_eq!(subs[0].status, "working");
        assert_eq!(
            subs[0].task,
            "Wire pagination controls into the users list UI"
        );
        assert_eq!(subs[1].name, "be-agent");

        // be-agent streams activity, then completes with a transcript
        assert_eq!(subs[2].activity, "reading src/routes/users.ts");
        assert_eq!(subs[3].status, "done");
        assert_eq!(
            subs[3].transcript,
            vec!["reading src/routes/users.ts", "12 tests pass · +36 −3"]
        );

        // fe-agent is a shallow stream: done with no transcript
        assert_eq!(subs[4].id, "task_fe");
        assert_eq!(subs[4].status, "done");
        assert!(subs[4].transcript.is_empty());
    }

    #[test]
    fn prompt_blocks_carry_resource_links() {
        let (bridge, rx, id) = start_ready();
        bridge
            .prompt_blocks(
                id,
                json!([
                    { "type": "text", "text": "look at " },
                    { "type": "resource_link", "uri": "file:///tmp/foo.ts", "name": "foo.ts" },
                ]),
            )
            .unwrap();
        let (text, _) = drain_turn(&rx);
        assert_eq!(text, "linked:foo.ts");
        bridge.kill(id).unwrap();
    }

    #[test]
    fn prompt_blocks_carry_images() {
        let (bridge, rx, id) = start_ready();
        bridge
            .prompt_blocks(
                id,
                json!([
                    { "type": "text", "text": "what is this" },
                    { "type": "image", "data": "aGVsbG8=", "mimeType": "image/png" },
                ]),
            )
            .unwrap();
        let (text, _) = drain_turn(&rx);
        assert_eq!(text, "images:1:image/png");
        bridge.kill(id).unwrap();
    }

    #[test]
    fn session_load_replays_history_and_continues() {
        let (tx, rx) = mpsc::channel();
        let bridge = AcpBridge::new(move |e| {
            tx.send(e).ok();
        });
        let id = bridge
            .start(&fake_agent(), "/tmp", None, Some("sess_old".into()))
            .unwrap();

        let mut replay = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match rx.recv_timeout(deadline - Instant::now()).unwrap() {
                AcpEvent::SessionReady { session_id, .. } => {
                    assert_eq!(session_id, "sess_old");
                    break;
                }
                ev => replay.push(ev),
            }
        }
        assert!(
            replay
                .iter()
                .any(|e| matches!(e, AcpEvent::UserText { text, .. } if text == "old question")),
            "missing replayed user text: {replay:?}"
        );
        assert!(
            replay
                .iter()
                .any(|e| matches!(e, AcpEvent::AgentText { text, .. } if text == "old answer")),
            "missing replayed agent text: {replay:?}"
        );

        // config options may arrive after SessionReady
        loop {
            match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                AcpEvent::ConfigOptions { .. } => break,
                _ => {}
            }
        }
        bridge.prompt(id, "hi").unwrap();
        let (text, _) = drain_turn(&rx);
        assert_eq!(text, "Hello world");
        bridge.kill(id).unwrap();
    }

    #[test]
    fn available_commands_pass_through() {
        let (bridge, rx, id) = start_ready();
        bridge.prompt(id, "commands").unwrap();
        let (text, others) = drain_turn(&rx);
        assert_eq!(text, "done");
        let commands = others
            .iter()
            .find_map(|e| match e {
                AcpEvent::AvailableCommands { commands, .. } => Some(commands),
                _ => None,
            })
            .expect("no AvailableCommands event");
        assert_eq!(commands[0]["name"], "compact");
        assert_eq!(commands[1]["input"]["hint"], "pr number");
        bridge.kill(id).unwrap();
    }

    #[test]
    fn plan_updates_pass_through() {
        let (bridge, rx, id) = start_ready();
        bridge.prompt(id, "plan").unwrap();
        let (text, others) = drain_turn(&rx);
        assert_eq!(text, "done");
        let plans: Vec<&Value> = others
            .iter()
            .filter_map(|e| match e {
                AcpEvent::Plan { update, .. } => Some(update),
                _ => None,
            })
            .collect();
        assert_eq!(plans.len(), 2, "expected 2 plan updates: {others:?}");
        assert_eq!(plans[0]["entries"][0]["status"], "in_progress");
        assert_eq!(plans[1]["entries"][0]["status"], "completed");
        assert_eq!(plans[1]["entries"][1]["content"], "Write the fix");
        bridge.kill(id).unwrap();
    }

    #[test]
    fn thought_chunks_stream() {
        let (bridge, rx, id) = start_ready();
        bridge.prompt(id, "think").unwrap();
        let (text, others) = drain_turn(&rx);
        assert_eq!(text, "done");
        let thoughts: Vec<&str> = others
            .iter()
            .filter_map(|e| match e {
                AcpEvent::AgentThought { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(thoughts, vec!["hmm, ", "let me check"]);
        bridge.kill(id).unwrap();
    }

    #[test]
    fn set_mode_round_trip() {
        let (bridge, rx, id) = start_ready();
        bridge.set_mode(id, "acceptEdits").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match rx.recv_timeout(deadline - Instant::now()).unwrap() {
                AcpEvent::ConfigOptions { options, .. } => {
                    assert_eq!(options["currentModeId"], "acceptEdits");
                    break;
                }
                _ => {}
            }
        }
        bridge.kill(id).unwrap();
    }

    #[test]
    fn config_options_pass_through_and_update() {
        let (bridge, rx, id) = start_ready();
        bridge.set_config_option(id, "model", "gpt-5.2").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match rx.recv_timeout(deadline - Instant::now()).unwrap() {
                AcpEvent::ConfigOptions { options, .. }
                    if options.pointer("/configOptions/0/currentValue")
                        == Some(&json!("gpt-5.2")) =>
                {
                    break
                }
                _ => {}
            }
        }
        bridge.kill(id).unwrap();
    }

    #[test]
    fn kill_reaches_wrapper_grandchildren() {
        // agent behind a wrapper (like npx): sh forks node, which inherits
        // the stdout pipe. Without a process-group kill, killing sh leaves
        // node alive, EOF never fires, and this test times out.
        let (tx, rx) = mpsc::channel();
        let bridge = AcpBridge::new(move |e| {
            tx.send(e).ok();
        });
        let wrapper = AgentConfig {
            command: "sh".into(),
            args: vec![
                "-c".into(),
                format!(
                    "node {}/tests/fake_acp_agent.mjs",
                    env!("CARGO_MANIFEST_DIR")
                ),
            ],
            env: HashMap::new(),
        };
        let id = bridge.start(&wrapper, "/tmp", None, None).unwrap();
        match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            AcpEvent::SessionReady { .. } => {}
            other => panic!("expected SessionReady, got {other:?}"),
        }
        bridge.kill(id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match rx.recv_timeout(deadline - Instant::now()) {
                Ok(AcpEvent::AgentExit { .. }) => break,
                Ok(_) => {}
                Err(e) => panic!("no AgentExit after group kill: {e}"),
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
            others.iter().any(
                |e| matches!(e, AcpEvent::Error { message, .. } if message.contains("malformed"))
            ),
            "no malformed-message error in {others:?}"
        );
        // bridge still works after the malformed line
        bridge.prompt(id, "hi").unwrap();
        let (text, _) = drain_turn(&rx);
        assert_eq!(text, "Hello world");
    }
}
