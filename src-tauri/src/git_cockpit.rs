//! Higher-level Git workflows used by the docked Git cockpit. Commands stay
//! deliberately close to Git plumbing so restart recovery comes from `.git`.

use crate::git_status::{git, git_with_editor};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub revision: String,
    pub remote: Option<String>,
    pub upstream: Option<String>,
    pub current: bool,
    pub default: bool,
    pub protected: bool,
    pub worktree: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub refs: Vec<String>,
    pub continuation: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct HistoryFilter {
    pub revision: Option<String>,
    pub message: Option<String>,
    pub author: Option<String>,
    pub after: Option<String>,
    pub before: Option<String>,
    pub path: Option<String>,
    pub skip: Option<u32>,
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChangedPath {
    pub status: String,
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Comparison {
    pub current: String,
    pub selected: String,
    pub merge_base: Option<String>,
    pub topology: String,
    pub current_only: Vec<CommitInfo>,
    pub selected_only: Vec<CommitInfo>,
    pub files: Vec<ChangedPath>,
    pub merge_ff: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StashInfo {
    pub reference: String,
    pub revision: String,
    pub branch: String,
    pub message: String,
    pub timestamp: i64,
    pub files: Vec<ChangedPath>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConflictInfo {
    pub path: String,
    pub base: String,
    pub current: String,
    pub incoming: String,
    pub working: String,
    pub binary: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct PushPreview {
    pub local: String,
    pub remote: String,
    pub branch: String,
    pub creates: bool,
    pub expected_remote: Option<String>,
    pub rewritten: bool,
    pub force_allowed: bool,
    pub outgoing: Vec<CommitInfo>,
    pub removed: Vec<CommitInfo>,
    pub files: Vec<ChangedPath>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DeletePreview {
    pub branch: String,
    pub revision: String,
    pub merged: bool,
    pub blocked: Option<String>,
    pub unique_commits: Vec<CommitInfo>,
    pub containing_refs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileHistory {
    pub commits: Vec<CommitInfo>,
    pub previous_paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BlameLine {
    pub line: u32,
    pub hash: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RebaseStep {
    pub action: String,
    pub commit: String,
    pub message: Option<String>,
}

fn run(root: &str, args: &[&str]) -> Result<String, String> {
    git(root, args)
}

fn run_status(root: &str, args: &[&str]) -> (bool, String) {
    match Command::new("git").arg("-C").arg(root).args(args).output() {
        Ok(out) => (
            out.status.success(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&out.stderr),
                String::from_utf8_lossy(&out.stdout)
            )
            .trim()
            .to_owned(),
        ),
        Err(error) => (false, error.to_string()),
    }
}

fn parse_commits(raw: &str) -> Vec<CommitInfo> {
    raw.split('\x1e')
        .filter_map(|record| {
            let fields: Vec<_> = record.trim_matches('\n').split('\x1f').collect();
            (fields.len() >= 7).then(|| CommitInfo {
                hash: fields[0].to_owned(),
                parents: fields[1].split_whitespace().map(str::to_owned).collect(),
                subject: fields[2].to_owned(),
                author: fields[3].to_owned(),
                email: fields[4].to_owned(),
                timestamp: fields[5].parse().unwrap_or(0),
                refs: fields[6]
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect(),
                continuation: false,
            })
        })
        .collect()
}

fn log(root: &str, revisions: &[&str], limit: u32) -> Result<Vec<CommitInfo>, String> {
    let count = format!("--max-count={}", limit.min(1000));
    let mut args = vec![
        "log",
        "--date=unix",
        "--format=%H%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%ct%x1f%D%x1e",
        &count,
    ];
    args.extend_from_slice(revisions);
    run(root, &args).map(|raw| mark_continuations(parse_commits(&raw)))
}

fn mark_continuations(mut commits: Vec<CommitInfo>) -> Vec<CommitInfo> {
    let visible: HashSet<_> = commits.iter().map(|commit| commit.hash.clone()).collect();
    for commit in &mut commits {
        commit.continuation = commit
            .parents
            .iter()
            .any(|parent| !visible.contains(parent));
    }
    commits
}

fn changed_paths(raw: &str) -> Vec<ChangedPath> {
    raw.lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let status = fields.next()?.to_owned();
            let first = fields.next()?.to_owned();
            let second = fields.next().map(str::to_owned);
            Some(ChangedPath {
                status,
                path: second.clone().unwrap_or_else(|| first.clone()),
                old_path: second.map(|_| first),
            })
        })
        .collect()
}

fn current_branch(root: &str) -> Result<String, String> {
    run(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|value| value.trim().to_owned())
        .map_err(|_| "detached HEAD has no current branch".into())
}

fn validate_ref(root: &str, reference: &str) -> Result<(), String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("revision is empty".into());
    }
    run(
        root,
        &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
    )
    .map(|_| ())
    .map_err(|error| {
        if error.starts_with("failed to run git") {
            error
        } else {
            format!("unknown revision: {reference}")
        }
    })
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("invalid repository path".into());
    }
    Ok(())
}

pub fn branches(root: &str) -> Result<Vec<BranchInfo>, String> {
    let raw = run(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let defaults: HashSet<String> = run(
        root,
        &[
            "for-each-ref",
            "--format=%(symref:short)",
            "refs/remotes/*/HEAD",
        ],
    )
    .unwrap_or_default()
    .lines()
    .map(str::to_owned)
    .collect();
    let protected: HashSet<String> =
        run(root, &["config", "--get-all", "shorikai.protectedBranch"])
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect();
    let worktrees: HashMap<String, String> = run(root, &["worktree", "list", "--porcelain"])?
        .split("\n\n")
        .filter_map(|block| {
            let path = block
                .lines()
                .find_map(|line| line.strip_prefix("worktree "))?;
            let branch = block
                .lines()
                .find_map(|line| line.strip_prefix("branch refs/heads/"))?;
            Some((branch.to_owned(), path.to_owned()))
        })
        .collect();
    let mut result = Vec::new();
    for line in raw.lines() {
        let fields: Vec<_> = line.split('\0').collect();
        if fields.len() < 5 || fields[0].ends_with("/HEAD") {
            continue;
        }
        let is_remote = fields[0].starts_with("refs/remotes/");
        let remote = is_remote.then(|| fields[1].split('/').next().unwrap_or("").to_owned());
        let local_name = (!is_remote).then_some(fields[1]);
        let is_default = defaults.contains(fields[1])
            || local_name.is_some_and(|name| {
                defaults.iter().any(|default| {
                    default
                        .split_once('/')
                        .is_some_and(|(_, branch)| branch == name)
                })
            });
        result.push(BranchInfo {
            name: fields[1].to_owned(),
            revision: fields[2].to_owned(),
            remote,
            upstream: (!fields[3].is_empty()).then(|| fields[3].to_owned()),
            current: fields[4] == "*",
            default: is_default,
            protected: is_default || protected.contains(fields[1]),
            worktree: local_name.and_then(|name| worktrees.get(name).cloned()),
        });
    }
    Ok(result)
}

pub fn fetch(root: &str, remote: Option<&str>) -> Result<(), String> {
    let mut args = vec!["fetch", "--prune"];
    if let Some(remote) = remote {
        args.push(remote);
    }
    run(root, &args).map(|_| ())
}

pub fn checkout(root: &str, target: &str, smart: bool) -> Result<(), String> {
    validate_ref(root, target)?;
    let refs = branches(root)?;
    if refs
        .iter()
        .any(|branch| branch.name == target && branch.remote.is_some())
    {
        let local = target
            .split_once('/')
            .map(|(_, name)| name)
            .unwrap_or(target);
        if refs
            .iter()
            .any(|branch| branch.remote.is_none() && branch.name == local)
        {
            return Err(format!(
                "local branch {local} already exists; compare it with {target}"
            ));
        }
        return run(root, &["switch", "--track", "-c", local, target]).map(|_| ());
    }
    let (ok, message) = run_status(root, &["switch", target]);
    if ok {
        return Ok(());
    }
    if !smart {
        return Err(message);
    }
    let label = format!("Shorikai smart checkout {}", std::process::id());
    run(root, &["stash", "push", "-u", "-m", &label])?;
    if let Err(error) = run(root, &["switch", target]) {
        let _ = run(root, &["stash", "pop"]);
        return Err(error);
    }
    let (restored, restoration) = run_status(root, &["stash", "pop"]);
    if restored {
        Ok(())
    } else {
        Err(format!(
            "checkout completed; smart stash needs recovery: {restoration}"
        ))
    }
}

pub fn create_branch(
    root: &str,
    name: &str,
    start: Option<&str>,
    switch: bool,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("branch name is empty".into());
    }
    run(root, &["check-ref-format", "--branch", name])?;
    if let Some(start) = start {
        validate_ref(root, start)?;
    }
    let mut args = vec![if switch { "switch" } else { "branch" }];
    if switch {
        args.extend(["-c", name]);
    } else {
        args.push(name);
    }
    if let Some(start) = start {
        args.push(start);
    }
    run(root, &args).map(|_| ())
}

pub fn history(root: &str, filter: &HistoryFilter) -> Result<Vec<CommitInfo>, String> {
    if let Some(revision) = filter.revision.as_deref().filter(|value| {
        (4..=40).contains(&value.len())
            && value.chars().all(|character| character.is_ascii_hexdigit())
    }) {
        validate_ref(root, revision)?;
        return log(root, &[revision], 1);
    }
    let count = format!("--max-count={}", filter.limit.unwrap_or(200).min(1000));
    let skip = format!("--skip={}", filter.skip.unwrap_or(0));
    let mut owned = Vec::new();
    if let Some(value) = &filter.message {
        owned.push(format!("--grep={value}"));
    }
    if let Some(value) = &filter.author {
        owned.push(format!("--author={value}"));
    }
    if let Some(value) = &filter.after {
        owned.push(format!("--after={value}"));
    }
    if let Some(value) = &filter.before {
        owned.push(format!("--before={value}"));
    }
    let mut args = vec![
        "log".to_owned(),
        "--extended-regexp".to_owned(),
        "--date=unix".to_owned(),
        "--format=%H%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%ct%x1f%D%x1e".to_owned(),
        count,
        skip,
    ];
    args.extend(owned);
    if let Some(revisions) = filter.revision.as_deref() {
        let mut any = false;
        for revision in revisions
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            validate_ref(root, revision)?;
            args.push(revision.to_owned());
            any = true;
        }
        if !any {
            args.push("--all".into());
        }
    } else {
        args.push("--all".into());
    }
    if let Some(path) = &filter.path {
        validate_path(path)?;
        args.push("--".into());
        args.push(path.clone());
    }
    let refs: Vec<_> = args.iter().map(String::as_str).collect();
    run(root, &refs).map(|raw| mark_continuations(parse_commits(&raw)))
}

pub fn compare(root: &str, selected: &str) -> Result<Comparison, String> {
    validate_ref(root, selected)?;
    let current = current_branch(root)?;
    let merge_base = run(root, &["merge-base", &current, selected])
        .ok()
        .map(|v| v.trim().to_owned());
    let current_range = format!("{selected}..{current}");
    let selected_range = format!("{current}..{selected}");
    let current_only = log(root, &[&current_range], 500)?;
    let selected_only = log(root, &[&selected_range], 500)?;
    let topology = match (current_only.is_empty(), selected_only.is_empty()) {
        (true, true) => "identical",
        (true, false) => "fast-forward",
        (false, true) => "already-contained",
        (false, false) => "divergent",
    }
    .to_owned();
    let files = changed_paths(&run(root, &["diff", "--name-status", &current, selected])?);
    let merge_ff = run(root, &["config", "--get", "merge.ff"])
        .ok()
        .map(|value| value.trim().to_owned());
    Ok(Comparison {
        current,
        selected: selected.to_owned(),
        merge_base,
        topology,
        current_only,
        selected_only,
        files,
        merge_ff,
    })
}

pub fn commit_files(root: &str, commit: &str) -> Result<Vec<ChangedPath>, String> {
    validate_ref(root, commit)?;
    run(
        root,
        &[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "-r",
            "-M",
            "-C",
            "--name-status",
            commit,
        ],
    )
    .map(|raw| changed_paths(&raw))
}

pub fn commit_diff(
    root: &str,
    commit: &str,
    path: &str,
    old_path: Option<&str>,
) -> Result<crate::git_status::DiffTexts, String> {
    validate_ref(root, commit)?;
    validate_path(path)?;
    if let Some(path) = old_path {
        validate_path(path)?;
    }
    let parent = run(root, &["rev-parse", &format!("{commit}^")])
        .ok()
        .map(|v| v.trim().to_owned());
    let read = |spec: String| {
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["show", &spec])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| out.stdout)
            .unwrap_or_default()
    };
    let old = parent
        .map(|parent| read(format!("{parent}:{}", old_path.unwrap_or(path))))
        .unwrap_or_default();
    let new = read(format!("{commit}:{path}"));
    if old.contains(&0) || new.contains(&0) {
        return Err("binary file".into());
    }
    Ok(crate::git_status::DiffTexts {
        old_text: String::from_utf8_lossy(&old).into(),
        new_text: String::from_utf8_lossy(&new).into(),
    })
}

pub fn create_stash(root: &str, message: &str, untracked: bool) -> Result<(), String> {
    let message = message.trim();
    let mut args = vec!["stash", "push"];
    if untracked {
        args.push("-u");
    }
    if !message.is_empty() {
        args.extend(["-m", message]);
    }
    run(root, &args).map(|_| ())
}

pub fn stashes(root: &str) -> Result<Vec<StashInfo>, String> {
    let raw = run(root, &["stash", "list", "--format=%gd%x1f%H%x1f%gs%x1f%ct"])?;
    raw.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let fields: Vec<_> = line.split('\x1f').collect();
            if fields.len() < 4 {
                return Err("invalid stash record".into());
            }
            let message = fields[2]
                .split_once(": ")
                .map(|(_, m)| m)
                .unwrap_or(fields[2]);
            let branch = fields[2]
                .strip_prefix("On ")
                .and_then(|v| v.split_once(':'))
                .map(|(b, _)| b)
                .unwrap_or("");
            let files = changed_paths(&run(root, &["stash", "show", "--name-status", fields[0]])?);
            Ok(StashInfo {
                reference: fields[0].into(),
                revision: fields[1].into(),
                branch: branch.into(),
                message: message.into(),
                timestamp: fields[3].parse().unwrap_or(0),
                files,
            })
        })
        .collect()
}

pub fn stash_action(root: &str, action: &str, reference: &str) -> Result<(), String> {
    if !reference.starts_with("stash@{") {
        return Err("invalid stash reference".into());
    }
    match action {
        "apply" | "pop" | "drop" => run(root, &["stash", action, reference]).map(|_| ()),
        _ => Err("unknown stash action".into()),
    }
}

fn stage_text(root: &str, stage: u8, path: &str) -> Vec<u8> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["show", &format!(":{stage}:{path}")])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| out.stdout)
        .unwrap_or_default()
}

pub fn conflicts(root: &str) -> Result<Vec<ConflictInfo>, String> {
    let raw = run(root, &["diff", "--name-only", "--diff-filter=U"])?;
    raw.lines()
        .map(|path| {
            validate_path(path)?;
            let base = stage_text(root, 1, path);
            let current = stage_text(root, 2, path);
            let incoming = stage_text(root, 3, path);
            let working = std::fs::read(Path::new(root).join(path)).unwrap_or_default();
            let binary = [&base, &current, &incoming, &working]
                .iter()
                .any(|bytes| bytes.contains(&0));
            Ok(ConflictInfo {
                path: path.into(),
                base: String::from_utf8_lossy(&base).into(),
                current: String::from_utf8_lossy(&current).into(),
                incoming: String::from_utf8_lossy(&incoming).into(),
                working: String::from_utf8_lossy(&working).into(),
                binary,
            })
        })
        .collect()
}

pub fn resolve(
    root: &str,
    path: &str,
    content: Option<&str>,
    side: Option<&str>,
) -> Result<(), String> {
    validate_path(path)?;
    let target = Path::new(root).join(path);
    if let Some(content) = content {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, content).map_err(|e| e.to_string())?;
    } else {
        let stage = match side {
            Some("current") => 2,
            Some("incoming") => 3,
            _ => return Err("choose current or incoming".into()),
        };
        let bytes = stage_text(root, stage, path);
        if bytes.is_empty() {
            let _ = std::fs::remove_file(&target);
        } else {
            std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
        }
    }
    run(root, &["add", "-A", "--", path]).map(|_| ())
}

fn push_destination(root: &str) -> Result<(String, String), String> {
    let branch = current_branch(root)?;
    let configured = run(
        root,
        &["config", "--get", &format!("branch.{branch}.pushRemote")],
    )
    .or_else(|_| run(root, &["config", "--get", "remote.pushDefault"]))
    .or_else(|_| {
        run(
            root,
            &["config", "--get", &format!("branch.{branch}.remote")],
        )
    })
    .ok()
    .map(|s| s.trim().to_owned())
    .filter(|s| s != ".");
    let remotes: Vec<_> = run(root, &["remote"])?.lines().map(str::to_owned).collect();
    let remote = configured
        .or_else(|| (remotes.len() == 1).then(|| remotes[0].clone()))
        .or_else(|| {
            remotes
                .iter()
                .any(|r| r == "origin")
                .then(|| "origin".into())
        })
        .ok_or("remote destination is ambiguous")?;
    Ok((remote, branch))
}

pub fn push_preview(root: &str) -> Result<PushPreview, String> {
    let (remote, branch) = push_destination(root)?;
    let remote_ref = format!("refs/remotes/{remote}/{branch}");
    let expected_remote = run(root, &["rev-parse", "--verify", &remote_ref])
        .ok()
        .map(|s| s.trim().into());
    let rewritten = expected_remote.is_some()
        && !run_status(root, &["merge-base", "--is-ancestor", &remote_ref, "HEAD"]).0;
    let protected = branches(root)?
        .iter()
        .any(|item| item.name == format!("{remote}/{branch}") && item.protected);
    let force_allowed = !protected
        || run(
            root,
            &[
                "config",
                "--bool",
                "--get",
                &format!("shorikai.allowForcePush.{remote}.{branch}"),
            ],
        )
        .ok()
        .is_some_and(|value| value.trim() == "true");
    let range = expected_remote
        .as_ref()
        .map(|_| format!("{remote_ref}..HEAD"))
        .unwrap_or_else(|| "HEAD".into());
    let outgoing = log(root, &[&range], 500)?;
    let removed = if rewritten {
        log(root, &[&format!("HEAD..{remote_ref}")], 500)?
    } else {
        Vec::new()
    };
    let files = if expected_remote.is_some() {
        changed_paths(&run(root, &["diff", "--name-status", &remote_ref, "HEAD"])?)
    } else {
        changed_paths(&run(
            root,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "-r",
                "--name-status",
                "HEAD",
            ],
        )?)
    };
    Ok(PushPreview {
        local: branch.clone(),
        remote,
        branch,
        creates: expected_remote.is_none(),
        expected_remote,
        rewritten,
        force_allowed,
        outgoing,
        removed,
        files,
    })
}

pub fn push(root: &str, force_lease: bool, expected: Option<&str>) -> Result<(), String> {
    let preview = push_preview(root)?;
    if force_lease {
        if !preview.rewritten {
            return Err(
                "force-with-lease is only available after a verified history rewrite".into(),
            );
        }
        if !preview.force_allowed {
            return Err("repository policy protects this remote branch from force updates".into());
        }
        let expected = expected.ok_or("force-with-lease requires the fetched remote revision")?;
        if preview.expected_remote.as_deref() != Some(expected) {
            return Err("remote revision changed; fetch and compare before retrying".into());
        }
        let lease = format!(
            "--force-with-lease=refs/heads/{}:{expected}",
            preview.branch
        );
        let result = run(
            root,
            &[
                "push",
                &lease,
                &preview.remote,
                &format!("HEAD:refs/heads/{}", preview.branch),
            ],
        )
        .map(|_| ());
        if result.is_err() {
            let _ = fetch(root, Some(&preview.remote));
        }
        result
    } else {
        let result = if preview.creates {
            run(
                root,
                &[
                    "push",
                    "--set-upstream",
                    &preview.remote,
                    &format!("HEAD:refs/heads/{}", preview.branch),
                ],
            )
            .map(|_| ())
        } else {
            run(
                root,
                &[
                    "push",
                    &preview.remote,
                    &format!("HEAD:refs/heads/{}", preview.branch),
                ],
            )
            .map(|_| ())
        };
        if result.is_err() && !preview.creates {
            let _ = fetch(root, Some(&preview.remote));
        }
        result
    }
}

pub fn merge(root: &str, branch: &str) -> Result<(), String> {
    let preview = compare(root, branch)?;
    let ff = preview.merge_ff.as_deref();
    match preview.topology.as_str() {
        "identical" | "already-contained" => Ok(()),
        "fast-forward" if ff == Some("false") => run(
            root,
            &["merge", "--no-ff", "--no-commit", "--autostash", branch],
        )
        .map(|_| ()),
        "fast-forward" => run(root, &["merge", "--ff-only", "--autostash", branch]).map(|_| ()),
        _ if preview.merge_base.is_none() => {
            Err("unrelated histories must be merged in Terminal".into())
        }
        _ if ff == Some("only") => Err("merge.ff=only blocks a divergent merge".into()),
        _ => run(root, &["merge", "--no-commit", "--autostash", branch]).map(|_| ()),
    }
}

fn ensure_clean_index(root: &str) -> Result<(), String> {
    let (clean, _) = run_status(root, &["diff", "--cached", "--quiet"]);
    clean
        .then_some(())
        .ok_or_else(|| "existing staged work must be committed or stashed first".into())
}

pub fn cherry_pick(root: &str, commits: &[String]) -> Result<(), String> {
    ensure_clean_index(root)?;
    if commits.is_empty() {
        return Err("select at least one commit".into());
    }
    for commit in commits {
        validate_ref(root, commit)?;
    }
    let mut args = vec!["cherry-pick"];
    args.extend(commits.iter().map(String::as_str));
    git_with_editor(root, &args).map(|_| ())
}

pub fn start_revert(root: &str, commit: &str) -> Result<String, String> {
    ensure_clean_index(root)?;
    validate_ref(root, commit)?;
    run(root, &["revert", "--no-commit", commit])?;
    run(
        root,
        &[
            "show",
            "-s",
            "--format=Revert \"%s\"%n%nThis reverts commit %H.",
            commit,
        ],
    )
    .map(|s| s.trim().into())
}

pub fn exclude_revert_path(root: &str, path: &str) -> Result<(), String> {
    validate_path(path)?;
    run(
        root,
        &[
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            path,
        ],
    )
    .map(|_| ())
}

pub fn finish_revert(root: &str, message: &str) -> Result<(), String> {
    git_with_editor(root, &["commit", "-m", message]).map(|_| ())
}

pub fn rebase(root: &str, upstream: &str, autostash: bool) -> Result<(), String> {
    validate_ref(root, upstream)?;
    let mut args = vec!["rebase"];
    if autostash {
        args.push("--autostash");
    }
    args.push(upstream);
    git_with_editor(root, &args).map(|_| ())
}

pub fn rebase_action(root: &str, action: &str) -> Result<(), String> {
    match action {
        "continue" | "skip" | "abort" => {
            git_with_editor(root, &["rebase", &format!("--{action}")]).map(|_| ())
        }
        _ => Err("unknown rebase action".into()),
    }
}

pub fn interactive_rebase(root: &str, base: &str, steps: &[RebaseStep]) -> Result<(), String> {
    validate_ref(root, base)?;
    if steps.is_empty() {
        return Err("interactive rebase plan is empty".into());
    }
    let mut has_previous = false;
    for step in steps {
        validate_ref(root, &step.commit)?;
        match step.action.as_str() {
            "pick" | "reword" | "drop" => {}
            "squash" | "fixup" if !has_previous => {
                return Err(format!("{} requires a preceding commit", step.action))
            }
            "squash" | "fixup" => {}
            _ => return Err(format!("unsupported rebase action: {}", step.action)),
        }
        if step.action != "drop" {
            has_previous = true;
        }
    }
    let git_dir = run(root, &["rev-parse", "--absolute-git-dir"])?;
    let state = Path::new(git_dir.trim()).join("shorikai-rebase");
    let _ = std::fs::remove_dir_all(&state);
    std::fs::create_dir_all(&state).map_err(|e| e.to_string())?;
    let mut todo = String::new();
    for (index, step) in steps.iter().enumerate() {
        let action = if step.action == "reword" {
            "pick"
        } else {
            &step.action
        };
        todo.push_str(&format!("{action} {}\n", step.commit));
        if matches!(step.action.as_str(), "reword" | "squash") {
            if let Some(message) = step
                .message
                .as_deref()
                .filter(|message| !message.trim().is_empty())
            {
                let file = state.join(format!("message-{index}"));
                std::fs::write(&file, message).map_err(|e| e.to_string())?;
                todo.push_str(&format!(
                    "exec git commit --amend -F {}\n",
                    shell_quote(&file.to_string_lossy())
                ));
            }
        }
    }
    let todo_file = state.join("todo");
    let editor = state.join("sequence-editor.sh");
    std::fs::write(&todo_file, todo).map_err(|e| e.to_string())?;
    std::fs::write(&editor, "#!/bin/sh\ncp \"$SHORIKAI_TODO\" \"$1\"\n")
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&editor, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rebase", "-i", base])
        .env(
            "GIT_SEQUENCE_EDITOR",
            shell_quote(&editor.to_string_lossy()),
        )
        .env("SHORIKAI_TODO", &todo_file)
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        let _ = std::fs::remove_dir_all(state);
        return Ok(());
    }
    Err(format!(
        "{}{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    )
    .trim()
    .into())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn delete_preview(root: &str, branch: &str) -> Result<DeletePreview, String> {
    let info = branches(root)?
        .into_iter()
        .find(|item| item.remote.is_none() && item.name == branch)
        .ok_or("local branch not found")?;
    let current = current_branch(root)?;
    let blocked = if branch == current {
        Some("current branch".into())
    } else if info.worktree.is_some() {
        Some("branch is checked out in a linked worktree".into())
    } else if info.protected {
        Some("protected branch; unprotect explicitly before deletion".into())
    } else {
        None
    };
    let merged = run_status(root, &["merge-base", "--is-ancestor", branch, &current]).0;
    let range = format!("{current}..{branch}");
    let unique_commits = log(root, &[&range], 500)?;
    let containing_refs = run(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--contains",
            &info.revision,
        ],
    )?
    .lines()
    .filter(|name| *name != branch)
    .map(str::to_owned)
    .collect();
    Ok(DeletePreview {
        branch: branch.into(),
        revision: info.revision,
        merged,
        blocked,
        unique_commits,
        containing_refs,
    })
}

#[derive(Clone)]
struct DeletedBranch {
    name: String,
    revision: String,
    upstream: Option<String>,
}
static DELETED: OnceLock<Mutex<HashMap<String, DeletedBranch>>> = OnceLock::new();

pub fn delete_branch(root: &str, branch: &str, force: bool, unprotect: bool) -> Result<(), String> {
    let preview = delete_preview(root, branch)?;
    if let Some(reason) = &preview.blocked {
        if !(unprotect && reason.starts_with("protected")) {
            return Err(reason.clone());
        }
    }
    if !preview.merged && !force {
        return Err("branch is not fully merged; compare it before Delete anyway".into());
    }
    let upstream = run(
        root,
        &[
            "for-each-ref",
            "--format=%(upstream:short)",
            &format!("refs/heads/{branch}"),
        ],
    )
    .ok()
    .map(|v| v.trim().into())
    .filter(|v: &String| !v.is_empty());
    run(root, &["branch", if force { "-D" } else { "-d" }, branch])?;
    DELETED
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(
            root.into(),
            DeletedBranch {
                name: branch.into(),
                revision: preview.revision,
                upstream,
            },
        );
    Ok(())
}

pub fn undo_delete(root: &str, alternate: Option<&str>) -> Result<(), String> {
    let record = DELETED
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .get(root)
        .cloned()
        .ok_or("no branch deletion to undo in this session")?;
    let name = alternate.unwrap_or(&record.name);
    if branches(root)?
        .iter()
        .any(|branch| branch.remote.is_none() && branch.name == name)
    {
        return Err("branch name is already in use; provide an alternate restore name".into());
    }
    run(root, &["branch", name, &record.revision])?;
    if let Some(upstream) = record.upstream {
        run(root, &["branch", "--set-upstream-to", &upstream, name])?;
    }
    Ok(())
}

pub fn file_history(root: &str, path: &str) -> Result<FileHistory, String> {
    validate_path(path)?;
    let raw = run(
        root,
        &[
            "log",
            "--all",
            "--follow",
            "--name-status",
            "--format=%H%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%ct%x1f%D%x1e",
            "--",
            path,
        ],
    )?;
    let previous_paths = raw
        .lines()
        .filter_map(|line| {
            let f: Vec<_> = line.split('\t').collect();
            (f.first()?.starts_with('R') && f.len() == 3).then(|| f[1].to_owned())
        })
        .collect();
    Ok(FileHistory {
        commits: parse_commits(&raw),
        previous_paths,
    })
}

pub fn blame(root: &str, path: &str, ignore_whitespace: bool) -> Result<Vec<BlameLine>, String> {
    validate_path(path)?;
    let mut args = vec!["blame", "--line-porcelain"];
    if ignore_whitespace {
        args.push("-w");
    }
    args.extend(["--", path]);
    let raw = run(root, &args)?;
    let mut result = Vec::new();
    let mut hash = String::new();
    let mut line = 0;
    let mut author = String::new();
    let mut email = String::new();
    let mut timestamp = 0;
    for row in raw.lines() {
        let parts: Vec<_> = row.split_whitespace().collect();
        if parts.len() >= 3 && parts[0].len() == 40 {
            hash = parts[0].into();
            line = parts[2].parse().unwrap_or(0);
        } else if let Some(v) = row.strip_prefix("author ") {
            author = v.into();
        } else if let Some(v) = row.strip_prefix("author-mail ") {
            email = v.trim_matches(['<', '>']).into();
        } else if let Some(v) = row.strip_prefix("author-time ") {
            timestamp = v.parse().unwrap_or(0);
        } else if let Some(text) = row.strip_prefix('\t') {
            result.push(BlameLine {
                line,
                hash: hash.clone(),
                author: author.clone(),
                email: email.clone(),
                timestamp,
                text: text.into(),
            });
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shorikai-cockpit-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        for args in [
            ["init", "-b", "main"],
            ["config", "user.email", "t@t.t"],
            ["config", "user.name", "Tester"],
        ] {
            run(root, &args).unwrap();
        }
        fs::write(dir.join("a.txt"), "base\n").unwrap();
        run(root, &["add", "."]).unwrap();
        run(root, &["commit", "-m", "base"]).unwrap();
        dir
    }

    fn commit(root: &str, path: &str, content: &str, message: &str) -> String {
        fs::write(Path::new(root).join(path), content).unwrap();
        run(root, &["add", "-A"]).unwrap();
        run(root, &["commit", "-m", message]).unwrap();
        run(root, &["rev-parse", "HEAD"]).unwrap().trim().to_owned()
    }

    fn filter() -> HistoryFilter {
        HistoryFilter {
            revision: None,
            message: None,
            author: None,
            after: None,
            before: None,
            path: None,
            skip: None,
            limit: None,
        }
    }

    #[test]
    fn invalid_revision_does_not_leak_git_fatal_error() {
        let dir = repo();
        let error = validate_ref(dir.to_str().unwrap(), "src/a.txt").unwrap_err();
        assert_eq!(error, "unknown revision: src/a.txt");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn history_compare_file_history_and_blame() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        run(root, &["switch", "-c", "feature"]).unwrap();
        fs::write(dir.join("a.txt"), "feature\n").unwrap();
        run(root, &["commit", "-am", "feature change"]).unwrap();
        run(root, &["switch", "main"]).unwrap();
        let comparison = compare(root, "feature").unwrap();
        assert_eq!(comparison.topology, "fast-forward");
        assert_eq!(comparison.selected_only.len(), 1);
        let filtered = history(
            root,
            &HistoryFilter {
                revision: None,
                message: Some("feature".into()),
                author: None,
                after: None,
                before: None,
                path: None,
                skip: None,
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(file_history(root, "a.txt").unwrap().commits.len(), 2);
        assert_eq!(blame(root, "a.txt", false).unwrap().len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn stash_and_safe_delete_round_trip() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "dirty\n").unwrap();
        create_stash(root, "named", false).unwrap();
        assert_eq!(stashes(root).unwrap().len(), 1);
        stash_action(root, "pop", "stash@{0}").unwrap();
        run(root, &["switch", "-c", "merged"]).unwrap();
        run(root, &["switch", "main"]).unwrap();
        delete_branch(root, "merged", false, false).unwrap();
        undo_delete(root, None).unwrap();
        assert!(branches(root).unwrap().iter().any(|b| b.name == "merged"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn force_push_requires_rewrite_matching_lease_and_policy() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        let remote = dir.with_extension("remote.git");
        let _ = fs::remove_dir_all(&remote);
        run(
            root,
            &[
                "init",
                "--bare",
                "--initial-branch=main",
                remote.to_str().unwrap(),
            ],
        )
        .unwrap();
        run(root, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
        run(root, &["push", "-u", "origin", "main"]).unwrap();
        let old = run(root, &["rev-parse", "origin/main"])
            .unwrap()
            .trim()
            .to_owned();
        fs::write(dir.join("a.txt"), "rewritten\n").unwrap();
        run(root, &["commit", "-am", "rewritten", "--amend"]).unwrap();
        let preview = push_preview(root).unwrap();
        assert!(preview.rewritten);
        assert!(preview.force_allowed);
        assert_eq!(preview.expected_remote.as_deref(), Some(old.as_str()));
        assert_eq!(preview.removed.len(), 1);
        push(root, true, Some(&old)).unwrap();
        fs::write(dir.join("a.txt"), "rewritten again\n").unwrap();
        run(root, &["commit", "-am", "again", "--amend"]).unwrap();
        assert!(
            push(root, true, Some(&old)).is_err(),
            "stale lease must fail before push"
        );
        run(
            root,
            &["config", "--add", "shorikai.protectedBranch", "origin/main"],
        )
        .unwrap();
        assert!(!push_preview(root).unwrap().force_allowed);
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(remote);
    }

    #[test]
    fn interactive_plan_rejects_invalid_sequences() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        let head = run(root, &["rev-parse", "HEAD"]).unwrap().trim().to_owned();
        let invalid = [RebaseStep {
            action: "squash".into(),
            commit: head.clone(),
            message: None,
        }];
        assert!(interactive_rebase(root, &head, &invalid)
            .unwrap_err()
            .contains("preceding commit"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn history_queries_git_pages_filters_and_exact_hashes() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        for index in 1..=5 {
            commit(
                root,
                "a.txt",
                &format!("{index}\n"),
                &format!("ticket {index}"),
            );
        }
        run(root, &["config", "user.name", "Other Author"]).unwrap();
        let exact = commit(root, "other.txt", "match\n", "regex target 42");

        let mut query = filter();
        query.limit = Some(2);
        let first = history(root, &query).unwrap();
        assert_eq!(first.len(), 2);
        assert!(
            first.last().unwrap().continuation,
            "page boundary must expose a continuation"
        );
        query.skip = Some(2);
        assert_eq!(history(root, &query).unwrap().len(), 2);

        query = filter();
        query.message = Some("target [0-9]+".into());
        query.author = Some("Other Author".into());
        query.path = Some("other.txt".into());
        assert_eq!(history(root, &query).unwrap()[0].hash, exact);

        query = filter();
        query.revision = Some(exact[..10].into());
        let direct = history(root, &query).unwrap();
        assert_eq!(
            direct.len(),
            1,
            "an exact abbreviated hash navigates, not paginates ancestors"
        );
        assert_eq!(direct[0].hash, exact);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn branch_checkout_tracks_remote_and_smart_stash_survives_conflict() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        let remote = dir.with_extension("remote.git");
        let _ = fs::remove_dir_all(&remote);
        run(
            root,
            &[
                "init",
                "--bare",
                "--initial-branch=main",
                remote.to_str().unwrap(),
            ],
        )
        .unwrap();
        run(root, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
        run(root, &["push", "-u", "origin", "main"]).unwrap();

        run(root, &["switch", "-c", "feature"]).unwrap();
        commit(root, "a.txt", "feature\n", "feature");
        run(root, &["push", "origin", "feature"]).unwrap();
        run(root, &["switch", "main"]).unwrap();
        run(root, &["branch", "-D", "feature"]).unwrap();
        fetch(root, Some("origin")).unwrap();
        assert!(branches(root)
            .unwrap()
            .iter()
            .any(|branch| branch.name == "origin/feature"));
        checkout(root, "origin/feature", false).unwrap();
        let feature = branches(root)
            .unwrap()
            .into_iter()
            .find(|branch| branch.name == "feature" && branch.remote.is_none())
            .unwrap();
        assert_eq!(feature.upstream.as_deref(), Some("origin/feature"));

        run(root, &["switch", "main"]).unwrap();
        fs::write(dir.join("a.txt"), "local work\n").unwrap();
        assert!(checkout(root, "feature", false).is_err());
        let recovery = checkout(root, "feature", true).unwrap_err();
        assert!(recovery.contains("needs recovery"));
        assert_eq!(current_branch(root).unwrap(), "feature");
        assert!(stashes(root)
            .unwrap()
            .iter()
            .any(|stash| stash.message.contains("Shorikai smart checkout")));
        let _ = run(root, &["merge", "--abort"]);
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(remote);
    }

    #[test]
    fn conflict_resolver_reconstructs_text_and_binary_index_stages() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        run(root, &["switch", "-c", "incoming"]).unwrap();
        commit(root, "a.txt", "incoming\n", "incoming text");
        fs::write(dir.join("binary.dat"), [0, 1, 2]).unwrap();
        run(root, &["add", "binary.dat"]).unwrap();
        run(root, &["commit", "-m", "incoming binary"]).unwrap();
        run(root, &["switch", "main"]).unwrap();
        commit(root, "a.txt", "current\n", "current text");
        fs::write(dir.join("binary.dat"), [0, 3, 4]).unwrap();
        run(root, &["add", "binary.dat"]).unwrap();
        run(root, &["commit", "-m", "current binary"]).unwrap();
        assert!(run(root, &["merge", "incoming"]).is_err());

        let items = conflicts(root).unwrap();
        let text = items.iter().find(|item| item.path == "a.txt").unwrap();
        assert_eq!(text.current, "current\n");
        assert_eq!(text.incoming, "incoming\n");
        assert!(text.working.contains("<<<<<<<"));
        let binary = items.iter().find(|item| item.path == "binary.dat").unwrap();
        assert!(binary.binary);
        resolve(root, "a.txt", Some("resolved\n"), None).unwrap();
        resolve(root, "binary.dat", None, Some("incoming")).unwrap();
        assert!(conflicts(root).unwrap().is_empty());
        let _ = run(root, &["merge", "--abort"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn merge_respects_ff_policy_and_pauses_true_merge_for_review() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        run(root, &["switch", "-c", "feature"]).unwrap();
        commit(root, "feature.txt", "feature\n", "feature");
        run(root, &["switch", "main"]).unwrap();
        run(root, &["config", "merge.ff", "false"]).unwrap();

        let preview = compare(root, "feature").unwrap();
        assert_eq!(preview.topology, "fast-forward");
        assert_eq!(preview.merge_ff.as_deref(), Some("false"));
        merge(root, "feature").unwrap();
        let pending = crate::git_status::status(root).unwrap().operation.unwrap();
        assert_eq!(pending.kind, "merge");
        assert!(pending.can_continue);
        crate::git_status::operation_action(root, "continue").unwrap();
        let parents = run(root, &["show", "-s", "--format=%P", "HEAD"]).unwrap();
        assert_eq!(parents.split_whitespace().count(), 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cherry_pick_handles_multiple_commits_late_conflict_continue_and_abort() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        run(root, &["switch", "-c", "source"]).unwrap();
        let first = commit(root, "one.txt", "one\n", "pick one");
        let second = commit(root, "a.txt", "source\n", "pick conflicting second");
        run(root, &["switch", "main"]).unwrap();
        commit(root, "a.txt", "main\n", "main divergence");

        assert!(cherry_pick(root, &[first.clone(), second.clone()]).is_err());
        assert!(run(root, &["log", "-1", "--format=%s", "HEAD"])
            .unwrap()
            .contains("pick one"));
        let pending = crate::git_status::status(root).unwrap().operation.unwrap();
        assert_eq!(pending.kind, "cherry_pick");
        assert_eq!(pending.conflicts, 1);
        resolve(root, "a.txt", Some("resolved\n"), None).unwrap();
        crate::git_status::operation_action(root, "continue").unwrap();
        assert_eq!(
            run(root, &["log", "-1", "--format=%s", "HEAD"])
                .unwrap()
                .trim(),
            "pick conflicting second"
        );

        run(root, &["reset", "--hard", "HEAD~2"]).unwrap();
        assert!(cherry_pick(root, &[first, second]).is_err());
        crate::git_status::operation_action(root, "abort").unwrap();
        assert!(crate::git_status::status(root).unwrap().operation.is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn revert_reviews_excludes_files_creates_separate_commits_and_aborts_conflict() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("b.txt"), "base b\n").unwrap();
        run(root, &["add", "."]).unwrap();
        run(root, &["commit", "-m", "add b"]).unwrap();
        fs::write(dir.join("a.txt"), "changed a\n").unwrap();
        fs::write(dir.join("b.txt"), "changed b\n").unwrap();
        run(root, &["add", "."]).unwrap();
        run(root, &["commit", "-m", "change both"]).unwrap();
        let both = run(root, &["rev-parse", "HEAD"]).unwrap().trim().to_owned();

        let message = start_revert(root, &both).unwrap();
        assert!(message.contains("Revert \"change both\""));
        exclude_revert_path(root, "b.txt").unwrap();
        finish_revert(root, &message).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "base\n");
        assert_eq!(
            fs::read_to_string(dir.join("b.txt")).unwrap(),
            "changed b\n"
        );

        let one = commit(root, "one.txt", "one\n", "one to revert");
        let two = commit(root, "two.txt", "two\n", "two to revert");
        for revision in [&two, &one] {
            let message = start_revert(root, revision).unwrap();
            finish_revert(root, &message).unwrap();
        }
        assert!(!dir.join("one.txt").exists() && !dir.join("two.txt").exists());
        let subjects = run(root, &["log", "-2", "--format=%s"]).unwrap();
        assert_eq!(
            subjects
                .lines()
                .filter(|subject| subject.starts_with("Revert"))
                .count(),
            2
        );

        let conflict_target = commit(root, "a.txt", "target\n", "target for conflicting revert");
        commit(root, "a.txt", "later\n", "later edit");
        assert!(start_revert(root, &conflict_target).is_err());
        let pending = crate::git_status::status(root).unwrap().operation.unwrap();
        assert_eq!(pending.kind, "revert");
        crate::git_status::operation_action(root, "abort").unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "later\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn linear_rebase_handles_clean_autostash_progress_skip_repeat_conflict_and_abort() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("b.txt"), "base b\n").unwrap();
        run(root, &["add", "."]).unwrap();
        run(root, &["commit", "-m", "add b"]).unwrap();
        run(root, &["switch", "-c", "feature"]).unwrap();
        let old = commit(root, "feature.txt", "feature\n", "feature clean");
        run(root, &["switch", "main"]).unwrap();
        commit(root, "main.txt", "main\n", "advance main");
        run(root, &["switch", "feature"]).unwrap();
        fs::write(dir.join("dirty.txt"), "dirty\n").unwrap();
        rebase(root, "main", true).unwrap();
        assert!(
            dir.join("dirty.txt").exists(),
            "native autostash restores untracked work"
        );
        let rewritten = run(root, &["rev-parse", "HEAD"]).unwrap();
        assert_ne!(rewritten.trim(), old);
        assert!(run_status(root, &["merge-base", "--is-ancestor", "main", "feature"]).0);

        run(root, &["reset", "--hard"]).unwrap();
        run(root, &["switch", "-c", "repeat", "HEAD~1"]).unwrap();
        commit(root, "a.txt", "repeat a\n", "repeat first");
        commit(root, "b.txt", "repeat b\n", "repeat second");
        run(root, &["switch", "main"]).unwrap();
        fs::write(dir.join("a.txt"), "main a\n").unwrap();
        fs::write(dir.join("b.txt"), "main b\n").unwrap();
        run(root, &["add", "."]).unwrap();
        run(root, &["commit", "-m", "conflict both"]).unwrap();
        run(root, &["switch", "repeat"]).unwrap();
        assert!(rebase(root, "main", false).is_err());
        let first = crate::git_status::status(root).unwrap().operation.unwrap();
        assert_eq!(first.kind, "rebase");
        assert_eq!(
            (first.progress_current, first.progress_total),
            (Some(1), Some(2))
        );
        assert!(first.current_commit.is_some());
        crate::git_status::operation_action(root, "skip").unwrap_err();
        let second = crate::git_status::status(root).unwrap().operation.unwrap();
        assert_eq!(second.progress_current, Some(2));
        assert_eq!(second.conflicts, 1);
        crate::git_status::operation_action(root, "abort").unwrap();
        assert!(crate::git_status::status(root).unwrap().operation.is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn interactive_rebase_executes_reorder_reword_squash_fixup_and_drop() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        run(root, &["switch", "-c", "feature"]).unwrap();
        let one = commit(root, "one.txt", "one\n", "one");
        let two = commit(root, "two.txt", "two\n", "two");
        let three = commit(root, "three.txt", "three\n", "three");
        let four = commit(root, "four.txt", "four\n", "four");
        let five = commit(root, "drop.txt", "drop\n", "drop me");
        let plan = [
            RebaseStep {
                action: "reword".into(),
                commit: two,
                message: Some("two rewritten".into()),
            },
            RebaseStep {
                action: "pick".into(),
                commit: one,
                message: None,
            },
            RebaseStep {
                action: "squash".into(),
                commit: three,
                message: Some("combined result".into()),
            },
            RebaseStep {
                action: "fixup".into(),
                commit: four,
                message: None,
            },
            RebaseStep {
                action: "drop".into(),
                commit: five,
                message: None,
            },
        ];
        interactive_rebase(root, "main", &plan).unwrap();
        let subjects = run(root, &["log", "main..HEAD", "--format=%s"]).unwrap();
        assert_eq!(
            subjects.lines().collect::<Vec<_>>(),
            ["combined result", "two rewritten"]
        );
        assert!(!dir.join("drop.txt").exists());
        assert!(dir.join("one.txt").exists() && dir.join("four.txt").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn delete_protects_remote_default_and_worktree_and_restores_under_alternate_name() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        let remote = dir.with_extension("remote.git");
        let linked = dir.with_extension("linked");
        let _ = fs::remove_dir_all(&remote);
        let _ = fs::remove_dir_all(&linked);
        run(
            root,
            &[
                "init",
                "--bare",
                "--initial-branch=main",
                remote.to_str().unwrap(),
            ],
        )
        .unwrap();
        run(root, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
        run(root, &["push", "-u", "origin", "main"]).unwrap();
        run(root, &["remote", "set-head", "origin", "-a"]).unwrap();
        run(root, &["switch", "-c", "other"]).unwrap();
        let protected = delete_preview(root, "main").unwrap();
        assert!(protected
            .blocked
            .as_deref()
            .unwrap()
            .starts_with("protected"));
        assert!(delete_branch(root, "main", false, false).is_err());
        delete_branch(root, "main", false, true).unwrap();
        undo_delete(root, None).unwrap();

        run(root, &["branch", "occupied"]).unwrap();
        run(
            root,
            &["worktree", "add", linked.to_str().unwrap(), "occupied"],
        )
        .unwrap();
        assert!(delete_preview(root, "occupied")
            .unwrap()
            .blocked
            .unwrap()
            .contains("worktree"));
        assert!(checkout(root, "occupied", false)
            .unwrap_err()
            .contains("already used by worktree"));
        run(
            root,
            &["worktree", "remove", "--force", linked.to_str().unwrap()],
        )
        .unwrap();

        run(root, &["branch", "recoverable"]).unwrap();
        delete_branch(root, "recoverable", false, false).unwrap();
        run(root, &["branch", "recoverable", "HEAD"]).unwrap();
        assert!(undo_delete(root, None)
            .unwrap_err()
            .contains("already in use"));
        undo_delete(root, Some("recoverable-restored")).unwrap();
        assert!(branches(root)
            .unwrap()
            .iter()
            .any(|branch| branch.name == "recoverable-restored"));
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(remote);
        let _ = fs::remove_dir_all(linked);
    }

    #[test]
    fn stash_supports_untracked_apply_pop_drop_and_conflict_recovery() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "stashed\n").unwrap();
        fs::write(dir.join("untracked.txt"), "untracked\n").unwrap();
        create_stash(root, "with untracked", true).unwrap();
        assert!(!dir.join("untracked.txt").exists());
        stash_action(root, "apply", "stash@{0}").unwrap();
        assert_eq!(stashes(root).unwrap().len(), 1, "Apply preserves the stash");
        run(root, &["reset", "--hard"]).unwrap();
        let _ = fs::remove_file(dir.join("untracked.txt"));
        stash_action(root, "pop", "stash@{0}").unwrap();
        assert!(stashes(root).unwrap().is_empty());

        run(root, &["reset", "--hard"]).unwrap();
        fs::write(dir.join("a.txt"), "stash conflict\n").unwrap();
        create_stash(root, "conflicting", false).unwrap();
        commit(
            root,
            "a.txt",
            "committed conflict\n",
            "conflicting base advance",
        );
        assert!(stash_action(root, "pop", "stash@{0}").is_err());
        assert_eq!(
            stashes(root).unwrap().len(),
            1,
            "failed Pop preserves recovery entry"
        );
        run(root, &["reset", "--hard"]).unwrap();
        stash_action(root, "drop", "stash@{0}").unwrap();
        assert!(stashes(root).unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn file_history_follows_rename_chain_and_whitespace_blame_preserves_origin() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        let origin = run(root, &["rev-parse", "HEAD"]).unwrap().trim().to_owned();
        run(root, &["mv", "a.txt", "middle.txt"]).unwrap();
        run(root, &["commit", "-m", "first rename"]).unwrap();
        run(root, &["mv", "middle.txt", "final.txt"]).unwrap();
        run(root, &["commit", "-m", "second rename"]).unwrap();
        let history = file_history(root, "final.txt").unwrap();
        assert!(history.previous_paths.contains(&"middle.txt".into()));
        assert!(history.previous_paths.contains(&"a.txt".into()));
        fs::write(dir.join("final.txt"), "  base\n").unwrap();
        run(root, &["commit", "-am", "whitespace only"]).unwrap();
        assert_ne!(blame(root, "final.txt", false).unwrap()[0].hash, origin);
        assert_eq!(blame(root, "final.txt", true).unwrap()[0].hash, origin);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn push_resolves_destinations_publishes_tracks_reconciles_rejection_and_blocks_detached() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        let remote = dir.with_extension("remote.git");
        let other_clone = dir.with_extension("other-clone");
        let backup = dir.with_extension("backup.git");
        let ambiguous = dir.with_extension("ambiguous.git");
        for path in [&remote, &other_clone, &backup, &ambiguous] {
            let _ = fs::remove_dir_all(path);
        }
        run(
            root,
            &[
                "init",
                "--bare",
                "--initial-branch=main",
                remote.to_str().unwrap(),
            ],
        )
        .unwrap();
        run(root, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
        run(root, &["push", "-u", "origin", "main"]).unwrap();

        run(root, &["switch", "-c", "feature"]).unwrap();
        commit(root, "feature.txt", "one\n", "feature one");
        let creation = push_preview(root).unwrap();
        assert!(creation.creates && !creation.outgoing.is_empty());
        push(root, false, None).unwrap();
        assert_eq!(
            run(root, &["rev-parse", "--abbrev-ref", "@{upstream}"])
                .unwrap()
                .trim(),
            "origin/feature"
        );
        commit(root, "feature.txt", "two\n", "feature two");
        assert_eq!(push_preview(root).unwrap().outgoing.len(), 1);
        push(root, false, None).unwrap();

        run(
            root,
            &[
                "clone",
                remote.to_str().unwrap(),
                other_clone.to_str().unwrap(),
            ],
        )
        .unwrap();
        let other = other_clone.to_str().unwrap();
        run(other, &["config", "user.email", "other@t.t"]).unwrap();
        run(other, &["config", "user.name", "Other"]).unwrap();
        run(other, &["switch", "feature"]).unwrap();
        let advanced = commit(other, "remote.txt", "remote\n", "remote advance");
        run(other, &["push", "origin", "feature"]).unwrap();
        commit(root, "local.txt", "local\n", "local advance");
        assert!(push(root, false, None).is_err());
        assert_eq!(
            run(root, &["rev-parse", "origin/feature"]).unwrap().trim(),
            advanced,
            "rejected push fetches the advanced remote ref"
        );

        run(root, &["init", "--bare", backup.to_str().unwrap()]).unwrap();
        run(root, &["remote", "add", "backup", backup.to_str().unwrap()]).unwrap();
        run(root, &["config", "branch.feature.pushRemote", "backup"]).unwrap();
        assert_eq!(push_preview(root).unwrap().remote, "backup");
        run(root, &["config", "--unset", "branch.feature.pushRemote"]).unwrap();
        assert_eq!(
            push_preview(root).unwrap().remote,
            "origin",
            "origin resolves otherwise ambiguous remotes"
        );
        run(root, &["init", "--bare", ambiguous.to_str().unwrap()]).unwrap();
        run(
            root,
            &["remote", "add", "other", ambiguous.to_str().unwrap()],
        )
        .unwrap();
        run(root, &["remote", "remove", "origin"]).unwrap();
        let _ = run(root, &["config", "--unset", "branch.feature.remote"]);
        assert!(push_preview(root).unwrap_err().contains("ambiguous"));

        run(root, &["checkout", "--detach"]).unwrap();
        assert!(push_preview(root).unwrap_err().contains("detached HEAD"));
        let _ = fs::remove_dir_all(dir);
        for path in [&remote, &other_clone, &backup, &ambiguous] {
            let _ = fs::remove_dir_all(path);
        }
    }

    #[test]
    fn conflict_resolver_handles_delete_modify() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        run(root, &["switch", "-c", "delete-side"]).unwrap();
        fs::remove_file(dir.join("a.txt")).unwrap();
        run(root, &["commit", "-am", "delete side"]).unwrap();
        run(root, &["switch", "main"]).unwrap();
        commit(root, "a.txt", "modify side\n", "modify side");
        assert!(run(root, &["merge", "delete-side"]).is_err());
        let deletion = conflicts(root)
            .unwrap()
            .into_iter()
            .find(|item| item.path == "a.txt")
            .unwrap();
        assert!(deletion.incoming.is_empty());
        resolve(root, "a.txt", None, Some("incoming")).unwrap();
        assert!(!dir.join("a.txt").exists());
        run(root, &["merge", "--abort"]).unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn comparison_classifies_all_topologies_and_history_preserves_merge_parents() {
        let dir = repo();
        let root = dir.to_str().unwrap();
        run(root, &["branch", "same"]).unwrap();
        assert_eq!(compare(root, "same").unwrap().topology, "identical");
        run(root, &["switch", "-c", "ahead"]).unwrap();
        commit(root, "ahead.txt", "ahead\n", "ahead");
        run(root, &["switch", "main"]).unwrap();
        assert_eq!(compare(root, "ahead").unwrap().topology, "fast-forward");
        run(root, &["merge", "--ff-only", "ahead"]).unwrap();
        assert_eq!(compare(root, "same").unwrap().topology, "already-contained");
        run(root, &["switch", "-c", "side", "same"]).unwrap();
        commit(root, "side.txt", "side\n", "side");
        run(root, &["switch", "main"]).unwrap();
        commit(root, "main.txt", "main\n", "main");
        assert_eq!(compare(root, "side").unwrap().topology, "divergent");
        run(root, &["merge", "--no-ff", "-m", "merge side", "side"]).unwrap();
        assert!(history(root, &filter())
            .unwrap()
            .iter()
            .any(|commit| commit.parents.len() == 2));
        let _ = fs::remove_dir_all(dir);
    }
}
