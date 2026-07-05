mod acp_bridge;
mod pty_host;

use acp_bridge::{AcpBridge, AcpEvent};
use pty_host::{PtyEvent, PtyHost};
use serde_json::Value;
use tauri::{Emitter, Manager, State};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<PtyHost>().kill_all();
                app.state::<AcpBridge>().kill_all();
            }
        });
}
