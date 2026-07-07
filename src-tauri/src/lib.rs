mod acp_bridge;
mod dap_core;
mod git_status;
mod lsp_host;
mod pty_host;
mod session_state;
mod workspace_index;

use acp_bridge::{AcpBridge, AcpEvent, AgentConfig};
use dap_core::DapCore;
use lsp_host::LspHost;
use pty_host::{PtyEvent, PtyHost};
use serde::Serialize;
use serde_json::Value;
use std::io::BufRead;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, State};
use workspace_index::WorkspaceIndex;

#[tauri::command]
fn pty_spawn(
    host: State<PtyHost>,
    cmd: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<(u32, Option<u32>), String> {
    host.spawn(cmd, cwd, cols, rows, env)
}

#[tauri::command]
fn pty_write(host: State<PtyHost>, id: u32, data: String) -> Result<(), String> {
    host.write(id, &data)
}

#[tauri::command]
fn pty_resize(host: State<PtyHost>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    host.resize(id, cols, rows)
}

#[tauri::command]
fn pty_kill(host: State<PtyHost>, id: u32) -> Result<(), String> {
    host.kill(id)
}

#[tauri::command]
fn pty_reset(host: State<PtyHost>) {
    host.kill_all();
}

/// v0 single-project root: the git root above the process cwd (in dev the
/// process runs in src-tauri), else the cwd itself. Project tabs (#12) will
/// replace this with real per-project roots.
#[tauri::command]
fn project_root() -> String {
    let cwd = std::env::current_dir().unwrap_or_else(|_| "/".into());
    let mut dir = cwd.as_path();
    loop {
        if dir.join(".git").exists() {
            return dir.to_string_lossy().into_owned();
        }
        match dir.parent() {
            Some(parent) => dir = parent,
            None => return cwd.to_string_lossy().into_owned(),
        }
    }
}

#[tauri::command]
fn acp_agents() -> Result<Value, String> {
    acp_bridge::load_agents()
}

fn strip_mcp_servers_from_toml(raw: &str) -> String {
    let mut out = Vec::new();
    let mut skipping = false;
    for line in raw.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            skipping = t.starts_with("[mcp_servers") || t.starts_with("[[mcp_servers");
        }
        if !skipping {
            out.push(line);
        }
    }
    out.join("\n") + "\n"
}

fn prepare_codex_home_for_shorikai(config: &mut AgentConfig) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let src = std::path::Path::new(&home).join(".codex");
    let dst = std::path::Path::new(&home).join(".config/shorikai/codex-home");
    std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;

    if let Ok(raw) = std::fs::read_to_string(src.join("config.toml")) {
        std::fs::write(dst.join("config.toml"), strip_mcp_servers_from_toml(&raw))
            .map_err(|e| e.to_string())?;
    }
    for name in ["auth.json", "installation_id", "models_cache.json"] {
        let from = src.join(name);
        if from.exists() {
            std::fs::copy(&from, dst.join(name)).map_err(|e| e.to_string())?;
        }
    }
    config
        .env
        .insert("CODEX_HOME".into(), dst.to_string_lossy().into_owned());
    Ok(())
}

fn mac_gui_path(existing: &str, home: Option<&str>) -> String {
    let mut parts: Vec<String> = existing.split(':').map(str::to_owned).collect();
    let mut add = |dir: String| {
        if !parts.iter().any(|p| p == &dir) {
            parts.push(dir);
        }
    };
    if let Some(home) = home {
        add(format!("{home}/.local/bin"));
    }
    add("/opt/homebrew/bin".into());
    add("/usr/local/bin".into());
    parts.join(":")
}

fn fix_gui_path() {
    let path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").ok();
    std::env::set_var("PATH", mac_gui_path(&path, home.as_deref()));
}

#[tauri::command]
fn acp_start(
    bridge: State<AcpBridge>,
    agent: String,
    cwd: String,
    effort: Option<String>,
    resume: Option<String>,
) -> Result<u32, String> {
    let mut config = acp_bridge::load_agent_config(&agent)?;
    if agent == "codex" && !config.env.contains_key("CODEX_HOME") {
        prepare_codex_home_for_shorikai(&mut config)?;
    }
    // claude-code adapter forwards _meta.claudeCode.options into the SDK
    let meta = effort.map(|e| serde_json::json!({ "claudeCode": { "options": { "effort": e } } }));
    bridge.start(&config, &cwd, meta, resume)
}

#[tauri::command]
fn acp_prompt(bridge: State<AcpBridge>, id: u32, text: String) -> Result<(), String> {
    bridge.prompt(id, &text)
}

#[tauri::command]
fn acp_prompt_blocks(bridge: State<AcpBridge>, id: u32, prompt: Value) -> Result<(), String> {
    bridge.prompt_blocks(id, prompt)
}

#[tauri::command]
fn acp_permission_response(
    bridge: State<AcpBridge>,
    id: u32,
    request_id: Value,
    option_id: Option<String>,
) -> Result<(), String> {
    bridge.respond_permission(id, request_id, option_id)
}

#[tauri::command]
fn acp_set_mode(bridge: State<AcpBridge>, id: u32, mode_id: String) -> Result<(), String> {
    bridge.set_mode(id, &mode_id)
}

#[tauri::command]
fn acp_set_model(bridge: State<AcpBridge>, id: u32, model_id: String) -> Result<(), String> {
    bridge.set_model(id, &model_id)
}

#[tauri::command]
fn acp_set_config_option(
    bridge: State<AcpBridge>,
    id: u32,
    config_id: String,
    value: String,
) -> Result<(), String> {
    bridge.set_config_option(id, &config_id, &value)
}

#[tauri::command]
fn acp_cancel(bridge: State<AcpBridge>, id: u32) -> Result<(), String> {
    bridge.cancel(id)
}

#[tauri::command]
fn acp_kill(bridge: State<AcpBridge>, id: u32) -> Result<(), String> {
    bridge.kill(id)
}

#[tauri::command]
fn acp_reset(bridge: State<AcpBridge>) {
    bridge.kill_all();
}

/// 5h/7d plan utilization from the same OAuth endpoint Claude Code's /usage
/// uses, authenticated with the Claude Code keychain credential.
/// ponytail: shells out to security + curl instead of adding an HTTP dep
#[tauri::command]
fn plan_usage() -> Result<Value, String> {
    let creds = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !creds.status.success() {
        return Err("no Claude Code credentials in keychain".into());
    }
    let creds: Value = serde_json::from_slice(&creds.stdout).map_err(|e| e.to_string())?;
    let token = creds
        .pointer("/claudeAiOauth/accessToken")
        .and_then(|v| v.as_str())
        .ok_or("no access token in credentials")?;
    let out = std::process::Command::new("curl")
        .args([
            "-sf",
            "-m",
            "10",
            "https://api.anthropic.com/api/oauth/usage",
            "-H",
            &format!("Authorization: Bearer {token}"),
            "-H",
            "anthropic-beta: oauth-2025-04-20",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("usage endpoint request failed".into());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("usage endpoint: {e}"))
}

/// Context tokens currently in use for a Claude Code session: usage of the
/// last assistant message in the transcript the SDK writes under
/// ~/.claude/projects/<cwd-slug>/<session-id>.jsonl
#[tauri::command]
fn claude_context_usage(cwd: String, session_id: String) -> Result<Value, String> {
    if session_id.contains('/') || session_id.contains("..") {
        return Err("invalid session id".into());
    }
    let path = claude_project_dir(&cwd)?.join(format!("{session_id}.jsonl"));
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // ponytail: whole-file read + reverse scan; tail-seek if transcripts get huge
    for line in text.lines().rev() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(usage) = entry.pointer("/message/usage") else {
            continue;
        };
        let tokens: u64 = [
            "input_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        ]
        .iter()
        .map(|k| usage.get(*k).and_then(|v| v.as_u64()).unwrap_or(0))
        .sum();
        if tokens > 0 {
            return Ok(serde_json::json!({ "context_tokens": tokens }));
        }
    }
    Ok(serde_json::json!({ "context_tokens": 0 }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSession {
    session_id: String,
    title: String,
    updated_at: u64,
}

fn claude_project_dir(cwd: &str) -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let slug: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Ok(std::path::Path::new(&home)
        .join(".claude/projects")
        .join(slug))
}

fn first_user_line(path: &std::path::Path) -> String {
    let Ok(file) = std::fs::File::open(path) else {
        return "Untitled session".into();
    };
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let content = &v["message"]["content"];
        let text = content.as_str().map(str::to_owned).or_else(|| {
            content.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
        });
        if let Some(s) = text.map(|s| s.trim().replace('\n', " ")) {
            if !s.is_empty() {
                return s.chars().take(80).collect();
            }
        }
    }
    "Untitled session".into()
}

#[tauri::command]
fn claude_session_history(cwd: String) -> Result<Vec<ClaudeSession>, String> {
    let dir = claude_project_dir(&cwd)?;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(Vec::new());
    };
    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        let updated_at = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        sessions.push(ClaudeSession {
            session_id,
            title: first_user_line(&path),
            updated_at,
        });
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    sessions.truncate(50);
    Ok(sessions)
}

#[tauri::command]
fn ws_watch(index: State<WorkspaceIndex>, root: String) -> Result<(), String> {
    index.watch(std::path::Path::new(&root))
}

#[tauri::command]
fn ws_unwatch(index: State<WorkspaceIndex>, root: String) {
    index.unwatch(&root);
}

#[tauri::command]
fn session_load() -> Result<Value, String> {
    session_state::load()
}

#[tauri::command]
fn session_save(state: Value) -> Result<(), String> {
    session_state::save(&state)
}

#[tauri::command]
fn ws_list(path: String) -> Result<Vec<workspace_index::Entry>, String> {
    workspace_index::list_dir(std::path::Path::new(&path))
}

#[tauri::command]
fn ws_fuzzy(
    index: State<WorkspaceIndex>,
    root: String,
    query: String,
) -> Result<Vec<String>, String> {
    index.fuzzy(&root, &query)
}

#[tauri::command]
fn ws_search(root: String, query: String) -> Result<Vec<workspace_index::SearchHit>, String> {
    workspace_index::search(&root, &query)
}

/// 10MB cap: keeps huge blobs from freezing the webview; binary files are
/// rejected rather than mangled.
#[tauri::command]
fn fs_read(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err(format!(
            "file is too large to open ({:.1} MB, limit 10 MB)",
            meta.len() as f64 / 1_048_576.0
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("binary file".into());
    }
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".into())
}

#[tauri::command]
fn fs_write(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn lsp_start(
    host: State<LspHost>,
    command: String,
    args: Vec<String>,
    cwd: String,
) -> Result<u32, String> {
    host.start(&command, &args, &cwd)
}

#[tauri::command]
fn lsp_send(host: State<LspHost>, id: u32, message: Value) -> Result<(), String> {
    host.send(id, &message)
}

#[tauri::command]
fn lsp_kill(host: State<LspHost>, id: u32) -> Result<(), String> {
    host.kill(id)
}

#[tauri::command]
fn lsp_reset(host: State<LspHost>) {
    host.kill_all();
}

#[tauri::command]
async fn dap_start_debug_terminal(
    core: State<'_, std::sync::Arc<DapCore>>,
    root: String,
) -> Result<u32, String> {
    let core = std::sync::Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.start_debug_terminal(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn dap_reply_run_in_terminal(
    core: State<std::sync::Arc<DapCore>>,
    session_id: u32,
    request_seq: i64,
    shell_pid: Option<u32>,
) -> Result<(), String> {
    core.reply_run_in_terminal(session_id, request_seq, shell_pid)
}

#[tauri::command]
fn dap_set_breakpoints(core: State<std::sync::Arc<DapCore>>, path: String, lines: Vec<u32>) {
    core.set_breakpoints(&path, lines);
}

#[tauri::command]
fn dap_continue(
    core: State<std::sync::Arc<DapCore>>,
    session_id: u32,
    thread_id: i64,
) -> Result<(), String> {
    core.continue_(session_id, thread_id)
}

#[tauri::command]
fn dap_reset(core: State<std::sync::Arc<DapCore>>) {
    core.stop_all();
}

/// Go launch target: <root>/.shorikai/debug.json {"go": {"program": ".", "args": []}}
fn go_launch_config(root: &str) -> (String, Vec<String>) {
    let path = std::path::Path::new(root).join(".shorikai/debug.json");
    let cfg: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    let program = cfg
        .pointer("/go/program")
        .and_then(|p| p.as_str())
        .unwrap_or(".")
        .to_owned();
    let args = cfg
        .pointer("/go/args")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    (program, args)
}

#[tauri::command]
async fn dap_start_go(
    core: State<'_, std::sync::Arc<DapCore>>,
    root: String,
) -> Result<u32, String> {
    let core = std::sync::Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || {
        let (program, args) = go_launch_config(&root);
        core.start_go_debug(&root, &program, args)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn dap_step(
    core: State<std::sync::Arc<DapCore>>,
    session_id: u32,
    thread_id: i64,
    kind: String,
) -> Result<(), String> {
    core.step(session_id, thread_id, &kind)
}

#[tauri::command]
async fn dap_stack_trace(
    core: State<'_, std::sync::Arc<DapCore>>,
    session_id: u32,
    thread_id: i64,
) -> Result<Value, String> {
    let core = std::sync::Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.stack_trace(session_id, thread_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn dap_scopes(
    core: State<'_, std::sync::Arc<DapCore>>,
    session_id: u32,
    frame_id: i64,
) -> Result<Value, String> {
    let core = std::sync::Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.scopes(session_id, frame_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn dap_variables(
    core: State<'_, std::sync::Arc<DapCore>>,
    session_id: u32,
    variables_reference: i64,
) -> Result<Value, String> {
    let core = std::sync::Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.variables(session_id, variables_reference))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn dap_evaluate(
    core: State<'_, std::sync::Arc<DapCore>>,
    session_id: u32,
    expression: String,
    frame_id: Option<i64>,
) -> Result<Value, String> {
    let core = std::sync::Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.evaluate(session_id, &expression, frame_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn lsp_servers() -> Result<Value, String> {
    lsp_host::load_server_config()
}

#[tauri::command]
fn which_cmd(command: String) -> bool {
    lsp_host::which(&command)
}

#[tauri::command]
async fn lsp_install(tool: String, packages: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || lsp_host::install(&tool, &packages))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn git_status_cmd(root: String) -> Result<git_status::GitStatus, String> {
    git_status::status(&root)
}

#[tauri::command]
fn git_stage(root: String, path: String) -> Result<(), String> {
    git_status::stage(&root, &path)
}

#[tauri::command]
fn git_stage_all(root: String) -> Result<(), String> {
    git_status::stage_all(&root)
}

#[tauri::command]
fn git_unstage(root: String, path: String) -> Result<(), String> {
    git_status::unstage(&root, &path)
}

#[tauri::command]
fn git_stash_all(root: String) -> Result<(), String> {
    git_status::stash_all(&root)
}

#[tauri::command]
fn git_commit(root: String, message: String) -> Result<(), String> {
    git_status::commit(&root, &message)
}

#[tauri::command]
fn git_push(root: String) -> Result<(), String> {
    git_status::push(&root)
}

#[tauri::command]
fn git_diff(root: String, path: String) -> Result<git_status::DiffTexts, String> {
    git_status::diff_texts(&root, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    fix_gui_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(|app| {
            #[cfg(target_os = "macos")]
            let app_menu = Submenu::with_items(
                app,
                app.package_info().name.clone(),
                true,
                &[
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let open_chat = MenuItem::with_id(
                app,
                "open-chat",
                "Open AI Chat",
                true,
                Some("CmdOrCtrl+Shift+A"),
            )?;
            let open_terminal = MenuItem::with_id(
                app,
                "open-terminal",
                "Open Terminal",
                true,
                Some("CmdOrCtrl+Shift+J"),
            )?;
            let toggle_terminal = MenuItem::with_id(
                app,
                "toggle-terminal",
                "Toggle Terminal",
                true,
                Some("CmdOrCtrl+J"),
            )?;
            let view = Submenu::with_items(
                app,
                "View",
                true,
                &[&open_chat, &open_terminal, &toggle_terminal],
            )?;
            Menu::with_items(
                app,
                &[
                    #[cfg(target_os = "macos")]
                    &app_menu,
                    &view,
                ],
            )
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if matches!(id, "open-chat" | "open-terminal" | "toggle-terminal") {
                let _ = app.emit("app:menu", id);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(PtyHost::new(move |event| {
                let name = match &event {
                    PtyEvent::Data { .. } => "pty:data",
                    PtyEvent::Exit { .. } => "pty:exit",
                };
                let _ = handle.emit(name, event);
            }));
            let handle = app.handle().clone();
            app.manage(AcpBridge::new(move |event: AcpEvent| {
                let _ = handle.emit("acp:event", event);
            }));
            let handle = app.handle().clone();
            app.manage(WorkspaceIndex::new(move |dirs| {
                let _ = handle.emit("ws:changed", serde_json::json!({ "paths": dirs }));
            }));
            let handle = app.handle().clone();
            app.manage(LspHost::new(move |event| {
                let _ = handle.emit("lsp:event", event);
            }));
            let handle = app.handle().clone();
            app.manage(std::sync::Arc::new(DapCore::new(move |event| {
                let _ = handle.emit("dap:event", event);
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_reset,
            project_root,
            acp_agents,
            acp_start,
            acp_prompt,
            acp_prompt_blocks,
            acp_permission_response,
            acp_set_mode,
            acp_set_model,
            acp_set_config_option,
            acp_cancel,
            acp_kill,
            acp_reset,
            plan_usage,
            claude_context_usage,
            claude_session_history,
            ws_watch,
            ws_unwatch,
            session_load,
            session_save,
            ws_list,
            ws_fuzzy,
            ws_search,
            fs_read,
            fs_write,
            git_status_cmd,
            git_stage,
            git_stage_all,
            git_unstage,
            git_stash_all,
            git_commit,
            git_push,
            git_diff,
            lsp_start,
            lsp_send,
            lsp_kill,
            lsp_reset,
            lsp_servers,
            which_cmd,
            lsp_install,
            dap_start_debug_terminal,
            dap_reply_run_in_terminal,
            dap_set_breakpoints,
            dap_continue,
            dap_reset,
            dap_step,
            dap_start_go,
            dap_stack_trace,
            dap_scopes,
            dap_variables,
            dap_evaluate,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<PtyHost>().kill_all();
                app.state::<AcpBridge>().kill_all();
                app.state::<LspHost>().kill_all();
                app.state::<std::sync::Arc<DapCore>>().stop_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_home_config_strips_mcp_servers_only() {
        let raw = r#"
model = "gpt-5.5"

[mcp_servers.notion]
url = "https://mcp.notion.com/mcp"

[mcp_servers.notion.env]
TOKEN = "secret"

[shell_environment_policy]
inherit = "core"
"#;
        let cleaned = strip_mcp_servers_from_toml(raw);
        assert!(cleaned.contains("model = \"gpt-5.5\""));
        assert!(cleaned.contains("[shell_environment_policy]"));
        assert!(!cleaned.contains("mcp_servers"));
        assert!(!cleaned.contains("secret"));
    }

    #[test]
    fn mac_gui_path_adds_user_cli_dirs_once() {
        let path = mac_gui_path("/usr/bin:/bin:/opt/homebrew/bin", Some("/Users/me"));
        assert!(path.contains("/Users/me/.local/bin"));
        assert!(path.contains("/usr/local/bin"));
        assert_eq!(path.matches("/opt/homebrew/bin").count(), 1);
    }
}
