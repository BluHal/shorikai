//! workspace-index: on-demand directory listing plus a recursive watcher that
//! reports which directories changed. Tauri-free; the app layer injects the
//! change callback. Search lands with #10.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const IGNORES: &[&str] = &[".git", "node_modules", ".DS_Store"];

#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

pub fn list_dir(path: &Path) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if IGNORES.contains(&name.as_str()) {
            continue;
        }
        out.push(Entry {
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: entry.file_type().map(|t| t.is_dir()).unwrap_or(false),
            name,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub struct WorkspaceIndex {
    watcher: Mutex<Option<RecommendedWatcher>>,
    on_change: Arc<dyn Fn(Vec<String>) + Send + Sync>,
}

impl WorkspaceIndex {
    pub fn new(on_change: impl Fn(Vec<String>) + Send + Sync + 'static) -> Self {
        Self {
            watcher: Mutex::new(None),
            on_change: Arc::new(on_change),
        }
    }

    /// Watch `root` recursively; replaces any previous watch. Changed
    /// directories are reported coalesced over a 250ms window.
    pub fn watch(&self, root: &Path) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        // dropping the old watcher closes its channel and ends its thread
        *self.watcher.lock().unwrap() = Some(watcher);

        let on_change = Arc::clone(&self.on_change);
        std::thread::spawn(move || coalesce_loop(rx, on_change));
        Ok(())
    }
}

fn coalesce_loop(
    rx: mpsc::Receiver<notify::Result<notify::Event>>,
    on_change: Arc<dyn Fn(Vec<String>) + Send + Sync>,
) {
    while let Ok(first) = rx.recv() {
        let mut dirs = HashSet::new();
        collect_dirs(first, &mut dirs);
        let deadline = Instant::now() + Duration::from_millis(250);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(ev) => collect_dirs(ev, &mut dirs),
                Err(_) => break,
            }
        }
        if !dirs.is_empty() {
            on_change(dirs.into_iter().collect());
        }
    }
}

fn collect_dirs(ev: notify::Result<notify::Event>, dirs: &mut HashSet<String>) {
    let Ok(ev) = ev else { return };
    for path in ev.paths {
        let s = path.to_string_lossy();
        if s.contains("/.git/") || s.contains("/node_modules/") || s.ends_with("/.git") {
            continue;
        }
        if let Some(parent) = path.parent() {
            dirs.insert(parent.to_string_lossy().into_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shorikai-wsidx-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join("src/a.ts"), "a").unwrap();
        fs::write(dir.join("src/b.ts"), "b").unwrap();
        fs::write(dir.join("README.md"), "hi").unwrap();
        dir
    }

    #[test]
    fn tree_build_with_ignores() {
        let dir = fixture();
        let root = list_dir(&dir).unwrap();
        let names: Vec<&str> = root.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "README.md"], "dirs first, ignores applied");
        assert!(root[0].is_dir);

        let src = list_dir(&dir.join("src")).unwrap();
        let names: Vec<&str> = src.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a.ts", "b.ts"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn watcher_reports_changed_dir() {
        let dir = fixture();
        let (tx, rx) = mpsc::channel();
        let idx = WorkspaceIndex::new(move |dirs| {
            tx.send(dirs).ok();
        });
        idx.watch(&dir).unwrap();
        // FSEvents needs a beat before it reports
        std::thread::sleep(Duration::from_millis(500));
        fs::write(dir.join("src/c.ts"), "c").unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let src = dir.join("src").to_string_lossy().into_owned();
        loop {
            let left = deadline
                .checked_duration_since(Instant::now())
                .expect("watcher never reported the changed dir");
            let dirs = match rx.recv_timeout(left) {
                Ok(d) => d,
                Err(e) => panic!("watcher never reported: {e}"),
            };
            // macOS tempdirs may come back with /private prefixed
            if dirs.iter().any(|d| d.ends_with(src.trim_start_matches("/private"))) {
                break;
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
