//! git-status: shells out to the git CLI (porcelain v1, NUL-separated).
//! Status, stage/unstage, commit, and diff-text extraction for the panel.
//! Push/pull/branch/merge stay in the terminal by design.

use serde::Serialize;
use std::process::Command;

#[derive(Clone, Debug, Serialize)]
pub struct GitFile {
    pub path: String,
    /// index status letter (M/A/D/R/…), None when nothing staged
    pub staged: Option<char>,
    /// worktree status letter (M/D/?/…), None when clean vs index
    pub unstaged: Option<char>,
    pub orig_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}

fn header_count(header: &str, key: &str) -> u32 {
    header
        .split_once(key)
        .and_then(|(_, rest)| {
            rest.trim_start()
                .split(|c: char| !c.is_ascii_digit())
                .next()?
                .parse()
                .ok()
        })
        .unwrap_or(0)
}

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let std = String::from_utf8_lossy(&out.stdout);
        return Err(format!("{}{}", err.trim(), std.trim()).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn status(root: &str) -> Result<GitStatus, String> {
    let out = git(root, &["status", "--porcelain", "-z", "--branch"])?;
    let mut branch = String::new();
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();
    let mut it = out.split('\0');
    while let Some(chunk) = it.next() {
        if chunk.is_empty() {
            continue;
        }
        if let Some(head) = chunk.strip_prefix("## ") {
            ahead = header_count(head, "ahead ");
            behind = header_count(head, "behind ");
            let head = head.split("...").next().unwrap_or(head);
            branch = head
                .strip_prefix("No commits yet on ")
                .unwrap_or(head)
                .to_owned();
            continue;
        }
        if chunk.len() < 4 {
            continue;
        }
        let bytes = chunk.as_bytes();
        let (x, y) = (bytes[0] as char, bytes[1] as char);
        let path = chunk[3..].to_owned();
        // in -z mode a rename's original path follows as its own entry
        let orig_path = if x == 'R' || x == 'C' || y == 'R' {
            it.next().map(str::to_owned)
        } else {
            None
        };
        files.push(GitFile {
            path,
            staged: (x != ' ' && x != '?').then_some(x),
            unstaged: (y != ' ').then_some(y),
            orig_path,
        });
    }
    Ok(GitStatus {
        branch,
        ahead,
        behind,
        files,
    })
}

pub fn stage(root: &str, path: &str) -> Result<(), String> {
    git(root, &["add", "--", path]).map(|_| ())
}

pub fn stage_all(root: &str) -> Result<(), String> {
    git(root, &["add", "-A"]).map(|_| ())
}

pub fn unstage(root: &str, path: &str) -> Result<(), String> {
    git(root, &["restore", "--staged", "--", path]).map(|_| ())
}

pub fn stash_all(root: &str) -> Result<(), String> {
    git(root, &["stash", "push", "-u"]).map(|_| ())
}

pub fn commit(root: &str, message: &str) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("commit message is empty".into());
    }
    git(root, &["commit", "-m", message]).map(|_| ())
}

#[derive(Clone, Debug, Serialize)]
pub struct DiffTexts {
    pub old_text: String,
    pub new_text: String,
}

/// Working-tree diff vs HEAD: old side from `git show HEAD:path` (empty for
/// new files), new side from the worktree (empty when deleted).
pub fn diff_texts(root: &str, path: &str) -> Result<DiffTexts, String> {
    let old_text = git(root, &["show", &format!("HEAD:{path}")]).unwrap_or_default();
    let file = std::path::Path::new(root).join(path);
    let new_text = match std::fs::read(&file) {
        Err(_) => String::new(),
        Ok(bytes) if bytes.len() > 10 * 1024 * 1024 => return Err("file too large to diff".into()),
        Ok(bytes) if bytes.contains(&0) => return Err("binary file".into()),
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
    };
    Ok(DiffTexts { old_text, new_text })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shorikai-git-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "t@t.t"],
            vec!["config", "user.name", "t"],
        ] {
            git(root, &args).unwrap();
        }
        dir
    }

    fn find<'a>(st: &'a GitStatus, path: &str) -> &'a GitFile {
        st.files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("{path} not in {:?}", st.files))
    }

    #[test]
    fn status_parses_across_states() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        fs::write(dir.join("gone.txt"), "bye\n").unwrap();
        fs::write(dir.join("moved.txt"), "here\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "init"]).unwrap();

        fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap(); // modified
        fs::write(dir.join("new.txt"), "hi\n").unwrap(); // untracked
        fs::write(dir.join("staged.txt"), "s\n").unwrap();
        git(root, &["add", "staged.txt"]).unwrap(); // staged add
        fs::remove_file(dir.join("gone.txt")).unwrap(); // deleted
        git(root, &["mv", "moved.txt", "renamed.txt"]).unwrap(); // rename

        let st = status(root).unwrap();
        assert_eq!(st.branch, "main");
        assert_eq!(find(&st, "a.txt").unstaged, Some('M'));
        assert_eq!(find(&st, "a.txt").staged, None);
        assert_eq!(find(&st, "new.txt").unstaged, Some('?'));
        assert_eq!(find(&st, "staged.txt").staged, Some('A'));
        assert_eq!(find(&st, "gone.txt").unstaged, Some('D'));
        let renamed = find(&st, "renamed.txt");
        assert_eq!(renamed.staged, Some('R'));
        assert_eq!(renamed.orig_path.as_deref(), Some("moved.txt"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stage_unstage_commit_round_trip() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "init"]).unwrap();

        fs::write(dir.join("a.txt"), "two\n").unwrap();
        stage(root, "a.txt").unwrap();
        assert_eq!(find(&status(root).unwrap(), "a.txt").staged, Some('M'));

        unstage(root, "a.txt").unwrap();
        let st = status(root).unwrap();
        assert_eq!(find(&st, "a.txt").staged, None);
        assert_eq!(find(&st, "a.txt").unstaged, Some('M'));

        stage(root, "a.txt").unwrap();
        commit(root, "change a").unwrap();
        assert!(status(root).unwrap().files.is_empty());

        assert!(commit(root, "   ").is_err(), "empty message must fail");
        assert!(commit(root, "nothing staged").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stage_all_and_stash_all() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "init"]).unwrap();

        fs::write(dir.join("a.txt"), "two\n").unwrap();
        fs::write(dir.join("new.txt"), "new\n").unwrap();
        stage_all(root).unwrap();
        let st = status(root).unwrap();
        assert_eq!(find(&st, "a.txt").staged, Some('M'));
        assert_eq!(find(&st, "new.txt").staged, Some('A'));

        fs::write(dir.join("later.txt"), "later\n").unwrap();
        stash_all(root).unwrap();
        assert!(status(root).unwrap().files.is_empty());
        assert!(!dir.join("later.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_extraction() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "old line\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "init"]).unwrap();
        fs::write(dir.join("a.txt"), "new line\n").unwrap();

        let d = diff_texts(root, "a.txt").unwrap();
        assert_eq!(d.old_text, "old line\n");
        assert_eq!(d.new_text, "new line\n");

        // new file: empty old side
        fs::write(dir.join("fresh.txt"), "hi\n").unwrap();
        let d = diff_texts(root, "fresh.txt").unwrap();
        assert_eq!(d.old_text, "");
        assert_eq!(d.new_text, "hi\n");
        let _ = fs::remove_dir_all(&dir);
    }
}
