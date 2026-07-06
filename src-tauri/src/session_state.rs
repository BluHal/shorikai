//! session-state: persists the project-tab registry and per-project layout
//! JSON to disk. The frontend owns the shape; this is dumb storage.

use serde_json::Value;
use std::path::PathBuf;

fn session_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(std::path::Path::new(&home).join(".config/shorikai/session.json"))
}

pub fn load() -> Result<Value, String> {
    let path = session_path()?;
    match std::fs::read_to_string(&path) {
        Err(_) => Ok(Value::Null),
        Ok(raw) => serde_json::from_str(&raw).or(Ok(Value::Null)),
    }
}

pub fn save(state: &Value) -> Result<(), String> {
    let path = session_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(state).unwrap()).map_err(|e| e.to_string())
}
