//! Git repository adapter. Status paths use porcelain v1 with NUL separators;
//! repository metadata and operation state come from stable Git plumbing.

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
    pub head: String,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub conflicts: u32,
    pub remotes: Vec<String>,
    pub default_branch: Option<String>,
    pub worktrees: Vec<GitWorktree>,
    pub operation: Option<GitOperation>,
    pub files: Vec<GitFile>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GitWorktree {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct GitOperation {
    pub kind: String,
    pub label: String,
    pub title: String,
    pub message: String,
    pub can_continue: bool,
    pub can_abort: bool,
    pub can_skip: bool,
    pub conflicts: u32,
    pub progress_current: Option<u32>,
    pub progress_total: Option<u32>,
    pub current_commit: Option<String>,
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

pub(crate) fn git(root: &str, args: &[&str]) -> Result<String, String> {
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

pub(crate) fn git_with_editor(root: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let std = String::from_utf8_lossy(&out.stdout);
        return Err(format!("{}{}", err.trim(), std.trim()).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_optional(root: &str, args: &[&str]) -> Option<String> {
    git(root, args)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn parse_worktrees(raw: &str) -> Vec<GitWorktree> {
    raw.split("\n\n")
        .filter_map(|block| {
            let mut path = None;
            let mut head = String::new();
            let mut branch = None;
            let mut detached = false;
            let mut bare = false;
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("worktree ") {
                    path = Some(value.to_owned());
                } else if let Some(value) = line.strip_prefix("HEAD ") {
                    head = value.to_owned();
                } else if let Some(value) = line.strip_prefix("branch ") {
                    branch = Some(
                        value
                            .strip_prefix("refs/heads/")
                            .unwrap_or(value)
                            .to_owned(),
                    );
                } else if line == "detached" {
                    detached = true;
                } else if line == "bare" {
                    bare = true;
                }
            }
            Some(GitWorktree {
                path: path?,
                head,
                branch,
                detached,
                bare,
            })
        })
        .collect()
}

fn default_branch(root: &str, remotes: &[String]) -> Option<String> {
    remotes.iter().find_map(|remote| {
        let reference = format!("refs/remotes/{remote}/HEAD");
        git_optional(root, &["symbolic-ref", "--quiet", "--short", &reference])
    })
}

fn operation_state(
    git_dir: &std::path::Path,
    detached: bool,
    head: &str,
    conflicts: u32,
) -> Option<GitOperation> {
    let supported =
        |kind: &str, label: &str, title: &str, action: &str, result: &str| GitOperation {
            kind: kind.to_owned(),
            label: label.to_owned(),
            title: title.to_owned(),
            message: if conflicts > 0 {
                format!(
                "Resolve {conflicts} conflict{}, then Continue {action}. Abort remains available.",
                if conflicts == 1 { "" } else { "s" }
            )
            } else {
                format!("Review the {result}, then Continue {action}. Abort remains available.")
            },
            can_continue: conflicts == 0,
            can_abort: true,
            can_skip: false,
            conflicts,
            progress_current: None,
            progress_total: None,
            current_commit: None,
        };

    if git_dir.join("MERGE_HEAD").exists() {
        return Some(supported(
            "merge",
            "MERGE",
            "Merge in progress",
            "Merge",
            "merge result",
        ));
    }
    if git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir() {
        let state_dir = if git_dir.join("rebase-merge").is_dir() {
            git_dir.join("rebase-merge")
        } else {
            git_dir.join("rebase-apply")
        };
        let read_number = |names: &[&str]| {
            names.iter().find_map(|name| {
                std::fs::read_to_string(state_dir.join(name))
                    .ok()?
                    .trim()
                    .parse::<u32>()
                    .ok()
            })
        };
        let progress_current = read_number(&["msgnum", "next"]);
        let progress_total = read_number(&["end", "last"]);
        let current_commit = ["stopped-sha", "original-commit"]
            .iter()
            .find_map(|name| std::fs::read_to_string(state_dir.join(name)).ok())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let commit_context = current_commit
            .as_deref()
            .map(|revision| format!(" Commit {}.", revision.chars().take(8).collect::<String>()))
            .unwrap_or_default();
        let autostash = git_dir.join("rebase-merge/autostash").exists()
            || git_dir.join("rebase-apply/autostash").exists();
        return Some(GitOperation {
            kind: "rebase".into(),
            label: "REBASE".into(),
            title: match (progress_current, progress_total) {
                (Some(current), Some(total)) => format!("Rebase {current} of {total}"),
                _ => "Rebase in progress".into(),
            },
            message: if conflicts > 0 {
                format!(
                    "Resolve {conflicts} conflict{}, then Continue, Skip, or Abort.{}{}",
                    if conflicts == 1 { "" } else { "s" },
                    if autostash {
                        " Autostash will be restored when the rebase ends."
                    } else {
                        ""
                    },
                    commit_context
                )
            } else {
                format!(
                    "Review the rewritten commit, then Continue, Skip, or Abort.{}{}",
                    if autostash {
                        " Autostash is active."
                    } else {
                        ""
                    },
                    commit_context
                )
            },
            can_continue: conflicts == 0,
            can_abort: true,
            can_skip: true,
            conflicts,
            progress_current,
            progress_total,
            current_commit,
        });
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return Some(supported(
            "cherry_pick",
            "CHERRY-PICK",
            "Cherry-pick in progress",
            "Cherry-pick",
            "cherry-pick result",
        ));
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return Some(supported(
            "revert",
            "REVERT",
            "Revert in progress",
            "Revert",
            "revert result",
        ));
    }
    if git_dir.join("BISECT_START").exists() {
        return Some(GitOperation {
            kind: "bisect".into(),
            label: "BISECT".into(),
            title: "External bisect detected".into(),
            message: "Bisect was started outside Shorikai. Open Terminal to continue.".into(),
            can_continue: false,
            can_abort: false,
            can_skip: false,
            conflicts,
            progress_current: None,
            progress_total: None,
            current_commit: None,
        });
    }
    detached.then(|| GitOperation {
        kind: "detached_head".into(),
        label: "DETACHED".into(),
        title: format!(
            "Detached HEAD at {}",
            head.chars().take(8).collect::<String>()
        ),
        message: "Create a branch before committing.".into(),
        can_continue: false,
        can_abort: false,
        can_skip: false,
        conflicts,
        progress_current: None,
        progress_total: None,
        current_commit: None,
    })
}

pub fn status(root: &str) -> Result<GitStatus, String> {
    let out = git(root, &["status", "--porcelain", "-z", "--branch"])?;
    let mut status_branch = String::new();
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
            status_branch = head
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
    let head = git_optional(root, &["rev-parse", "--verify", "HEAD"]).unwrap_or_default();
    let branch = git_optional(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .unwrap_or(status_branch);
    let detached =
        !head.is_empty() && git_optional(root, &["symbolic-ref", "--quiet", "HEAD"]).is_none();
    let upstream = git_optional(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    let conflicts = git(root, &["diff", "--name-only", "--diff-filter=U", "-z"])?
        .split('\0')
        .filter(|path| !path.is_empty())
        .count() as u32;
    let remotes = git(root, &["remote"])?
        .lines()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let default_branch = default_branch(root, &remotes);
    let worktrees = parse_worktrees(&git(root, &["worktree", "list", "--porcelain"])?);
    let git_dir = git(root, &["rev-parse", "--absolute-git-dir"])?;
    let operation = operation_state(
        std::path::Path::new(git_dir.trim()),
        detached,
        &head,
        conflicts,
    );
    Ok(GitStatus {
        branch,
        head,
        detached,
        upstream,
        ahead,
        behind,
        conflicts,
        remotes,
        default_branch,
        worktrees,
        operation,
        files,
    })
}

pub fn operation_action(root: &str, action: &str) -> Result<(), String> {
    let current = status(root)?
        .operation
        .ok_or_else(|| "no Git operation is in progress".to_owned())?;
    let verb = match action {
        "continue" if current.can_continue => "--continue",
        "abort" if current.can_abort => "--abort",
        "skip" if current.can_skip => "--skip",
        "continue" => return Err("resolve all conflicts before continuing".into()),
        "abort" => return Err("this operation must be handled in Terminal".into()),
        _ => return Err("unknown Git operation action".into()),
    };
    let command = match current.kind.as_str() {
        "merge" => "merge",
        "cherry_pick" => "cherry-pick",
        "revert" => "revert",
        "rebase" => "rebase",
        _ => return Err("this operation must be handled in Terminal".into()),
    };
    git_with_editor(root, &[command, verb]).map(|_| ())
}

pub fn create_branch(root: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("branch name is empty".into());
    }
    git(root, &["check-ref-format", "--branch", name])?;
    git(root, &["switch", "-c", name]).map(|_| ())
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

pub fn push(root: &str) -> Result<(), String> {
    git(root, &["push"]).map(|_| ())
}

#[derive(Clone, Debug, Serialize)]
pub struct DiffTexts {
    pub old_text: String,
    pub new_text: String,
}

fn checked_text(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("file too large to diff".into());
    }
    if bytes.contains(&0) {
        return Err("binary file".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn git_bytes(root: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    Ok(out.stdout)
}

/// Extract the exact Git boundary represented by a Source Control row.
/// Staged is HEAD -> index; unstaged is index -> working tree.
pub fn diff_texts(
    root: &str,
    path: &str,
    staged: bool,
    orig_path: Option<&str>,
) -> Result<DiffTexts, String> {
    let old_spec = if staged {
        format!("HEAD:{}", orig_path.unwrap_or(path))
    } else {
        format!(":{}", orig_path.unwrap_or(path))
    };
    let old_text = git_bytes(root, &["show", &old_spec])
        .ok()
        .map(checked_text)
        .transpose()?
        .unwrap_or_default();
    let new_text = if staged {
        git_bytes(root, &["show", &format!(":{path}")])
            .ok()
            .map(checked_text)
            .transpose()?
            .unwrap_or_default()
    } else {
        std::fs::read(std::path::Path::new(root).join(path))
            .ok()
            .map(checked_text)
            .transpose()?
            .unwrap_or_default()
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

        let d = diff_texts(root, "a.txt", false, None).unwrap();
        assert_eq!(d.old_text, "old line\n");
        assert_eq!(d.new_text, "new line\n");

        // new file: empty old side
        fs::write(dir.join("fresh.txt"), "hi\n").unwrap();
        let d = diff_texts(root, "fresh.txt", false, None).unwrap();
        assert_eq!(d.old_text, "");
        assert_eq!(d.new_text, "hi\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_uses_selected_staged_or_unstaged_boundary() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "head\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "init"]).unwrap();
        fs::write(dir.join("a.txt"), "index\n").unwrap();
        git(root, &["add", "a.txt"]).unwrap();
        fs::write(dir.join("a.txt"), "worktree\n").unwrap();

        let staged = diff_texts(root, "a.txt", true, None).unwrap();
        assert_eq!(
            (staged.old_text.as_str(), staged.new_text.as_str()),
            ("head\n", "index\n")
        );
        let unstaged = diff_texts(root, "a.txt", false, None).unwrap();
        assert_eq!(
            (unstaged.old_text.as_str(), unstaged.new_text.as_str()),
            ("index\n", "worktree\n")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_boundaries_preserve_empty_deleted_and_renamed_sides() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("old.txt"), "rename me\n").unwrap();
        fs::write(dir.join("delete.txt"), "delete me\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "files"]).unwrap();

        git(root, &["mv", "old.txt", "new.txt"]).unwrap();
        let renamed = diff_texts(root, "new.txt", true, Some("old.txt")).unwrap();
        assert_eq!(renamed.old_text, "rename me\n");
        assert_eq!(renamed.new_text, "rename me\n");

        fs::remove_file(dir.join("delete.txt")).unwrap();
        let deleted = diff_texts(root, "delete.txt", false, None).unwrap();
        assert_eq!(deleted.old_text, "delete me\n");
        assert!(deleted.new_text.is_empty());

        fs::write(dir.join("untracked.txt"), "new\n").unwrap();
        let untracked = diff_texts(root, "untracked.txt", false, None).unwrap();
        assert!(untracked.old_text.is_empty());
        assert_eq!(untracked.new_text, "new\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_worktree_and_detached_head() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        let remote = dir.with_extension("remote.git");
        let linked = dir.with_extension("linked-worktree");
        let _ = fs::remove_dir_all(&remote);
        let _ = fs::remove_dir_all(&linked);
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "init"]).unwrap();

        git(
            root,
            &[
                "init",
                "--bare",
                "--initial-branch=main",
                remote.to_str().unwrap(),
            ],
        )
        .unwrap();
        git(root, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
        git(root, &["push", "-u", "origin", "main"]).unwrap();
        git(root, &["remote", "set-head", "origin", "-a"]).unwrap();
        git(
            root,
            &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
        )
        .unwrap();

        let attached = status(root).unwrap();
        assert_eq!(attached.branch, "main");
        assert!(!attached.detached);
        assert_eq!(attached.head.len(), 40);
        assert_eq!(attached.upstream.as_deref(), Some("origin/main"));
        assert_eq!(attached.remotes, ["origin"]);
        assert_eq!(attached.default_branch.as_deref(), Some("origin/main"));
        assert_eq!(attached.worktrees.len(), 2);
        assert_eq!(attached.worktrees[0].branch.as_deref(), Some("main"));
        assert!(attached
            .worktrees
            .iter()
            .any(|worktree| worktree.branch.as_deref() == Some("linked")));

        git(root, &["checkout", "--detach"]).unwrap();
        let detached = status(root).unwrap();
        assert!(detached.detached);
        assert_eq!(detached.operation.as_ref().unwrap().kind, "detached_head");
        create_branch(root, "rescue/work").unwrap();
        let rescued = status(root).unwrap();
        assert_eq!(rescued.branch, "rescue/work");
        assert!(!rescued.detached);
        assert!(rescued.operation.is_none());
        git(
            root,
            &["worktree", "remove", "--force", linked.to_str().unwrap()],
        )
        .unwrap();
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&remote);
        let _ = fs::remove_dir_all(&linked);
    }

    #[test]
    fn detects_external_operation_markers() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "init"]).unwrap();
        let git_dir = dir.join(".git");

        fs::create_dir(git_dir.join("rebase-merge")).unwrap();
        assert_eq!(status(root).unwrap().operation.unwrap().kind, "rebase");
        fs::remove_dir(git_dir.join("rebase-merge")).unwrap();

        for (marker, kind) in [
            ("CHERRY_PICK_HEAD", "cherry_pick"),
            ("REVERT_HEAD", "revert"),
            ("BISECT_START", "bisect"),
        ] {
            fs::write(git_dir.join(marker), "marker\n").unwrap();
            assert_eq!(status(root).unwrap().operation.unwrap().kind, kind);
            fs::remove_file(git_dir.join(marker)).unwrap();
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_operation_can_continue_and_abort() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("base.txt"), "base\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "base"]).unwrap();

        git(root, &["checkout", "-b", "feature"]).unwrap();
        fs::write(dir.join("feature.txt"), "feature\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "feature"]).unwrap();
        git(root, &["checkout", "main"]).unwrap();
        git(root, &["merge", "--no-ff", "--no-commit", "feature"]).unwrap();

        let pending = status(root).unwrap().operation.unwrap();
        assert_eq!(pending.kind, "merge");
        assert!(pending.can_continue);
        operation_action(root, "continue").unwrap();
        assert!(status(root).unwrap().operation.is_none());

        git(root, &["checkout", "-b", "conflict", "HEAD~1"]).unwrap();
        fs::write(dir.join("base.txt"), "conflict branch\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "conflict side"]).unwrap();
        git(root, &["checkout", "main"]).unwrap();
        fs::write(dir.join("base.txt"), "main side\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "main side"]).unwrap();
        assert!(git(root, &["merge", "conflict"]).is_err());

        let conflicted = status(root).unwrap().operation.unwrap();
        assert_eq!(conflicted.kind, "merge");
        assert_eq!(conflicted.conflicts, 1);
        assert!(!conflicted.can_continue);
        assert!(conflicted.can_abort);
        operation_action(root, "abort").unwrap();
        assert!(status(root).unwrap().operation.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
