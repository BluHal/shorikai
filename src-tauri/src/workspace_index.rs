//! workspace-index: on-demand directory listing plus a recursive watcher that
//! reports which directories changed. Tauri-free; the app layer injects the
//! change callback. Search lands with #10.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher};
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
    watchers: Mutex<std::collections::HashMap<String, RecommendedWatcher>>,
    on_change: Arc<dyn Fn(Vec<String>) + Send + Sync>,
    /// per-root file lists for fuzzy matching, rebuilt lazily when dirty
    files_cache: Mutex<std::collections::HashMap<String, Arc<Vec<String>>>>,
    dirty_roots: Arc<Mutex<HashSet<String>>>,
}

impl WorkspaceIndex {
    pub fn new(on_change: impl Fn(Vec<String>) + Send + Sync + 'static) -> Self {
        Self {
            watchers: Mutex::new(std::collections::HashMap::new()),
            on_change: Arc::new(on_change),
            files_cache: Mutex::new(std::collections::HashMap::new()),
            dirty_roots: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Watch `root` recursively (idempotent per root; one watcher per open
    /// project). Changed directories are reported coalesced over 250ms.
    pub fn watch(&self, root: &Path) -> Result<(), String> {
        let key = root.to_string_lossy().into_owned();
        let mut watchers = self.watchers.lock().unwrap();
        if watchers.contains_key(&key) {
            return Ok(());
        }
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        watchers.insert(key.clone(), watcher);

        let on_change = Arc::clone(&self.on_change);
        let dirty = Arc::clone(&self.dirty_roots);
        std::thread::spawn(move || {
            coalesce_loop(
                rx,
                Arc::new(move |dirs: Vec<String>| {
                    dirty.lock().unwrap().insert(key.clone());
                    on_change(dirs);
                }),
            )
        });
        Ok(())
    }

    /// Stop watching a root (project tab closed); drops its caches too.
    pub fn unwatch(&self, root: &str) {
        self.watchers.lock().unwrap().remove(root);
        self.files_cache.lock().unwrap().remove(root);
        self.dirty_roots.lock().unwrap().remove(root);
    }

    /// Fuzzy-match `query` against project-relative file paths (gitignore
    /// respected). Empty query returns the first files alphabetically.
    pub fn fuzzy(&self, root: &str, query: &str) -> Result<Vec<String>, String> {
        let files = self.files(root)?;
        if query.is_empty() {
            return Ok(files.iter().take(50).cloned().collect());
        }
        let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
        let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
        let mut scored: Vec<(u32, &String)> = files
            .iter()
            .filter_map(|f| {
                let mut buf = Vec::new();
                pattern
                    .score(nucleo_matcher::Utf32Str::new(f, &mut buf), &mut matcher)
                    .map(|s| (s, f))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
        Ok(scored.into_iter().take(50).map(|(_, f)| f.clone()).collect())
    }

    fn files(&self, root: &str) -> Result<Arc<Vec<String>>, String> {
        let mut cache = self.files_cache.lock().unwrap();
        let dirty = self.dirty_roots.lock().unwrap().remove(root);
        if !dirty {
            if let Some(files) = cache.get(root) {
                return Ok(Arc::clone(files));
            }
        }
        let mut files = Vec::new();
        let walker = ignore::WalkBuilder::new(root)
            .hidden(false)
            .filter_entry(|e| e.file_name() != ".git")
            .build();
        for entry in walker.flatten() {
            if entry.file_type().is_some_and(|t| t.is_file()) {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    files.push(rel.to_string_lossy().into_owned());
                }
            }
        }
        files.sort();
        let files = Arc::new(files);
        cache.insert(root.to_owned(), Arc::clone(&files));
        Ok(files)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub line: u64,
    pub text: String,
    /// byte spans of the matches within `text`
    pub spans: Vec<(usize, usize)>,
}

/// Project-wide content search via ripgrep on PATH.
/// ponytail: PATH rg, not a bundled sidecar — bundle when packaging lands
pub fn search(root: &str, query: &str) -> Result<Vec<SearchHit>, String> {
    let output = std::process::Command::new("rg")
        .args([
            "--json",
            "--smart-case",
            "--max-count",
            "20",
            "--max-filesize",
            "1M",
            "--",
            query,
        ])
        .current_dir(root)
        .output()
        .map_err(|_| "ripgrep (rg) not found on PATH — brew install ripgrep".to_string())?;
    // rg exits 1 for "no matches", 2 for real errors
    if let Some(2) = output.status.code() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().filter_map(parse_rg_line).take(200).collect())
}

fn parse_rg_line(line: &str) -> Option<SearchHit> {
    let msg: serde_json::Value = serde_json::from_str(line).ok()?;
    if msg.get("type")?.as_str()? != "match" {
        return None;
    }
    let data = msg.get("data")?;
    let mut text = data
        .pointer("/lines/text")?
        .as_str()?
        .trim_end_matches('\n')
        .to_owned();
    let mut spans: Vec<(usize, usize)> = data
        .get("submatches")?
        .as_array()?
        .iter()
        .filter_map(|s| {
            Some((
                s.get("start")?.as_u64()? as usize,
                s.get("end")?.as_u64()? as usize,
            ))
        })
        .collect();
    // keep previews sane for minified/long lines
    if text.len() > 240 {
        let mut cut = 240;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push('…');
        spans.retain(|(s, _)| *s < cut);
    }
    Some(SearchHit {
        path: data.pointer("/path/text")?.as_str()?.to_owned(),
        line: data.pointer("/line_number")?.as_u64()?,
        text,
        spans,
    })
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
    fn fuzzy_ranking_sanity() {
        let dir = fixture();
        fs::write(dir.join("src/app_config.ts"), "x").unwrap();
        fs::write(dir.join("src/apple_confetti.md"), "x").unwrap();
        // gitignored files must not appear
        fs::write(dir.join(".gitignore"), "ignored.ts\n").unwrap();
        fs::write(dir.join("src/ignored.ts"), "x").unwrap();

        let idx = WorkspaceIndex::new(|_| {});
        let root = dir.to_string_lossy().into_owned();

        let hits = idx.fuzzy(&root, "appconf").unwrap();
        assert_eq!(
            hits.first().map(String::as_str),
            Some("src/app_config.ts"),
            "tight match should outrank scattered one: {hits:?}"
        );
        assert!(hits.contains(&"src/apple_confetti.md".to_string()));

        let all = idx.fuzzy(&root, "").unwrap();
        assert!(
            !all.iter().any(|f| f.contains("ignored.ts")),
            "gitignore not respected: {all:?}"
        );
        assert!(idx.fuzzy(&root, "zzzqqq").unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rg_json_line_parses_into_hit() {
        let line = r#"{"type":"match","data":{"path":{"text":"src/a.ts"},"lines":{"text":"const foo = paginate(query);\n"},"line_number":12,"absolute_offset":100,"submatches":[{"match":{"text":"paginate"},"start":12,"end":20}]}}"#;
        let hit = parse_rg_line(line).expect("should parse");
        assert_eq!(hit.path, "src/a.ts");
        assert_eq!(hit.line, 12);
        assert_eq!(hit.text, "const foo = paginate(query);");
        assert_eq!(hit.spans, vec![(12, 20)]);
        assert_eq!(&hit.text[12..20], "paginate");

        assert!(parse_rg_line(r#"{"type":"begin","data":{}}"#).is_none());
        assert!(parse_rg_line("not json").is_none());
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
