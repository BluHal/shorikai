mod acp_bridge;
mod git_status;
mod lsp_host;
mod pty_host;
mod session_state;
mod workspace_index;

use acp_bridge::{AcpBridge, AcpEvent};
use lsp_host::LspHost;
use pty_host::{PtyEvent, PtyHost};
use serde_json::Value;
use tauri::{Emitter, Manager, State};
use workspace_index::WorkspaceIndex;

#[tauri::command]
fn pty_spawn(
    host: State<PtyHost>,
    cmd: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    host.spawn(cmd, cwd, cols, rows)
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
fn acp_start(bridge: State<AcpBridge>, agent: String, cwd: String) -> Result<u32, String> {
    eprintln!("[acp] start requested: agent={agent} cwd={cwd}");
    let config = acp_bridge::load_agent_config(&agent)?;
    let started = bridge.start(&config, &cwd);
    eprintln!("[acp] start result: {started:?}");
    started
}

#[tauri::command]
fn acp_prompt(bridge: State<AcpBridge>, id: u32, text: String) -> Result<(), String> {
    bridge.prompt(id, &text)
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
fn git_unstage(root: String, path: String) -> Result<(), String> {
    git_status::unstage(&root, &path)
}

#[tauri::command]
fn git_commit(root: String, message: String) -> Result<(), String> {
    git_status::commit(&root, &message)
}

#[tauri::command]
fn git_diff(root: String, path: String) -> Result<git_status::DiffTexts, String> {
    git_status::diff_texts(&root, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_reset,
            project_root,
            acp_start,
            acp_prompt,
            acp_permission_response,
            acp_cancel,
            acp_kill,
            acp_reset,
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
            git_unstage,
            git_commit,
            git_diff,
            lsp_start,
            lsp_send,
            lsp_kill,
            lsp_reset,
            lsp_servers,
            which_cmd,
            lsp_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<PtyHost>().kill_all();
                app.state::<AcpBridge>().kill_all();
                app.state::<LspHost>().kill_all();
            }
        });
}
