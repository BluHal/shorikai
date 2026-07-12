import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IDockviewPanelProps } from "dockview-react";
import { bus } from "../bus";
import { getGitFor, refreshGit, subscribeGit } from "../gitStore";
import { useProjectRoot } from "../projects";

type Section = "branches" | "history" | "compare" | "stashes" | "conflicts" | "push" | "file";
type Commit = {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  email: string;
  timestamp: number;
  refs: string[];
  continuation: boolean;
};
type FileChange = { status: string; path: string; old_path: string | null };
type Branch = {
  name: string;
  revision: string;
  remote: string | null;
  upstream: string | null;
  current: boolean;
  default: boolean;
  protected: boolean;
  worktree: string | null;
};
type Comparison = {
  current: string;
  selected: string;
  merge_base: string | null;
  topology: string;
  current_only: Commit[];
  selected_only: Commit[];
  files: FileChange[];
  merge_ff: string | null;
};
type Stash = {
  reference: string;
  revision: string;
  branch: string;
  message: string;
  timestamp: number;
  files: FileChange[];
};
type Conflict = {
  path: string;
  base: string;
  current: string;
  incoming: string;
  working: string;
  binary: boolean;
};
type Push = {
  local: string;
  remote: string;
  branch: string;
  creates: boolean;
  expected_remote: string | null;
  rewritten: boolean;
  force_allowed: boolean;
  outgoing: Commit[];
  removed: Commit[];
  files: FileChange[];
};
type DeletePreview = {
  branch: string;
  revision: string;
  merged: boolean;
  blocked: string | null;
  unique_commits: Commit[];
  containing_refs: string[];
};
type FileHistory = { commits: Commit[]; previous_paths: string[] };
type Blame = { line: number; hash: string; author: string; email: string; timestamp: number; text: string };
type Diff = { path: string; oldText: string; newText: string };
type RebaseStep = {
  action: "pick" | "reword" | "squash" | "fixup" | "drop";
  commit: string;
  message: string | null;
  subject: string;
};
type Filters = { revision: string; message: string; author: string; after: string; before: string; path: string };

const EMPTY_FILTERS: Filters = { revision: "", message: "", author: "", after: "", before: "", path: "" };
const short = (hash: string) => hash.slice(0, 8);
const date = (timestamp: number) => new Date(timestamp * 1000).toLocaleString();

function CommitRows(props: {
  commits: Commit[];
  selected?: string;
  marked?: Set<string>;
  onSelect?: (commit: Commit) => void;
  onMark?: (commit: Commit) => void;
}) {
  return (
    <div className="git-cockpit-list">
      {props.commits.map((commit) => (
        <div key={commit.hash} className={`git-commit-row${props.selected === commit.hash ? " selected" : ""}`}>
          {props.onMark && (
            <button
              className={`git-commit-mark${props.marked?.has(commit.hash) ? " active" : ""}`}
              title="Add commit to operation selection"
              onClick={() => props.onMark?.(commit)}
            >
              {props.marked?.has(commit.hash) ? "✓" : "○"}
            </button>
          )}
          <button className="git-commit-main" onClick={() => props.onSelect?.(commit)}>
            <span className="git-graph-cell" title={`${commit.parents.length} parent${commit.parents.length === 1 ? "" : "s"}`}>
              <span className={`git-graph-dot${commit.parents.length > 1 ? " merge" : ""}`} />
              <span>{commit.parents.length > 1 ? "├─" : "│"}</span>
            </span>
            <span className="git-commit-subject">
              {commit.subject}
              {commit.refs.length > 0 && <small>{commit.refs.join(" · ")}</small>}
            </span>
            <span className="git-commit-author">{commit.author}</span>
            <code>{short(commit.hash)}</code>
            {commit.continuation && <span className="git-continuation" title="Parent is outside this page or filter">⋮</span>}
          </button>
        </div>
      ))}
      {props.commits.length === 0 && <div className="git-cockpit-empty">No commits in this topology.</div>}
    </div>
  );
}

function FileRows(props: {
  files: FileChange[];
  onSelect?: (file: FileChange) => void;
  onOpen?: (file: FileChange) => void;
  action?: (file: FileChange) => ReactNode;
}) {
  return (
    <div className="git-cockpit-list">
      {props.files.map((file) => (
        <div className="git-file-row" key={`${file.old_path ?? ""}:${file.path}`}>
          <button onClick={() => props.onSelect?.(file)} onDoubleClick={() => props.onOpen?.(file)}>
            <b>{file.status}</b>
            <span>{file.old_path ? `${file.old_path} → ` : ""}{file.path}</span>
          </button>
          {props.action?.(file)}
        </div>
      ))}
      {props.files.length === 0 && <div className="git-cockpit-empty">No changed files.</div>}
    </div>
  );
}

function DiffPreview({ diff }: { diff: Diff | null }) {
  if (!diff) return <div className="git-cockpit-empty">Select a file to preview its diff. Double-click to open Monaco Diff.</div>;
  return (
    <div className="git-inline-diff">
      <header>{diff.path}</header>
      <div><pre>{diff.oldText}</pre><pre>{diff.newText}</pre></div>
    </div>
  );
}

export function GitCockpitPane(props: IDockviewPanelProps<{ section?: Section; target?: string; nonce?: number }>) {
  const root = useProjectRoot();
  const git = useSyncExternalStore(subscribeGit, () => getGitFor(root));
  const [section, setSection] = useState<Section>(props.params.section ?? "history");
  const [target, setTarget] = useState(props.params.target ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchSearch, setBranchSearch] = useState("");
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selected, setSelected] = useState<Commit | null>(null);
  const [marked, setMarked] = useState(new Set<string>());
  const [files, setFiles] = useState<FileChange[]>([]);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null);
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [stashMessage, setStashMessage] = useState("");
  const [stashUntracked, setStashUntracked] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [result, setResult] = useState("");
  const [push, setPush] = useState<Push | null>(null);
  const [filePath, setFilePath] = useState("");
  const [fileHistory, setFileHistory] = useState<FileHistory | null>(null);
  const [blame, setBlame] = useState<Blame[]>([]);
  const [revertDraft, setRevertDraft] = useState<{ commit: Commit; message: string; files: FileChange[]; queue: Commit[] } | null>(null);
  const [rebasePlan, setRebasePlan] = useState<RebaseStep[]>([]);

  const navigate = (next: Section, nextTarget?: string) => {
    setTarget(nextTarget ?? "");
    if (next === "compare" && nextTarget === undefined) setComparison(null);
    setSection(next);
    setOffset(0);
    setError(null);
  };

  useEffect(() => {
    if (props.params.section) setSection(props.params.section);
    setTarget(props.params.target ?? "");
    if (props.params.target != null) {
      if (props.params.section === "file") setFilePath(props.params.target);
    }
  }, [props.params.section, props.params.target, props.params.nonce]);

  const loadCommit = async (commit: Commit) => {
    setSelected(commit);
    setDiff(null);
    setFiles(await invoke("git_commit_files", { root, commit: commit.hash }));
  };

  const load = async () => {
    setError(null);
    try {
      if (section === "branches") setBranches(await invoke("git_branches", { root }));
      if (section === "history") {
        setBranches(await invoke("git_branches", { root }));
        const revision = target || appliedFilters.revision || null;
        const page = await invoke<Commit[]>("git_history", {
          root,
          filter: {
            revision,
            message: appliedFilters.message || null,
            author: appliedFilters.author || null,
            after: appliedFilters.after || null,
            before: appliedFilters.before || null,
            path: appliedFilters.path || null,
            skip: offset,
            limit: 200,
          },
        });
        setCommits(offset ? [...commits, ...page] : page);
        if (!offset && revision && page[0]) await loadCommit(page[0]);
      }
      if (section === "compare" && target) setComparison(await invoke("git_compare", { root, selected: target }));
      if (section === "stashes") setStashes(await invoke("git_stashes", { root }));
      if (section === "conflicts") {
        const items = await invoke<Conflict[]>("git_conflicts", { root });
        setConflicts(items);
        if (conflict) {
          const refreshed = items.find((item) => item.path === conflict.path) ?? null;
          setConflict(refreshed);
          if (refreshed) setResult(refreshed.working);
        }
      }
      if (section === "push") setPush(await invoke("git_push_preview", { root }));
      if (section === "file" && filePath) setFileHistory(await invoke("git_file_history", { root, path: filePath }));
    } catch (reason) {
      setError(String(reason));
    }
  };

  useEffect(() => { void load(); }, [section, target, offset]);

  const execute = async (command: string, args: Record<string, unknown>, after: () => Promise<void> = load) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await invoke(command, { root, ...args });
      await refreshGit(root);
      await after();
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const previewRevisionFile = async (revision: string, file: FileChange, open = false) => {
    try {
      const texts = await invoke<{ old_text: string; new_text: string }>("git_commit_diff", {
        root,
        commit: revision,
        path: file.path,
        oldPath: file.old_path,
      });
      const next = { path: file.path, oldText: texts.old_text, newText: texts.new_text };
      setDiff(next);
      if (open) bus.openDiff(`${root}/${file.path}`, next.oldText, next.newText);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const fetchBranches = async () => {
    if (await execute("git_fetch", { remote: null })) setLastFetched(Date.now());
  };

  const checkout = async (branch: Branch, smart: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await invoke("git_checkout", { root, target: branch.name, smart });
      await refreshGit(root);
      await load();
    } catch (reason) {
      const text = String(reason);
      if (branch.remote && text.includes("already exists")) navigate("compare", branch.name);
      else setError(text);
    } finally {
      setBusy(false);
    }
  };

  const toggleMarked = (commit: Commit) => {
    const next = new Set(marked);
    if (next.has(commit.hash)) next.delete(commit.hash); else next.add(commit.hash);
    setMarked(next);
  };

  const selectedOperations = () => {
    const chosen = commits.filter((commit) => marked.has(commit.hash));
    return chosen.length ? chosen : selected ? [selected] : [];
  };

  const startRevert = async (queue = selectedOperations()) => {
    const [commit, ...remaining] = queue;
    if (!commit) return;
    setBusy(true);
    setError(null);
    try {
      const message = await invoke<string>("git_revert_start", { root, commit: commit.hash });
      const changed = await invoke<FileChange[]>("git_commit_files", { root, commit: commit.hash });
      setRevertDraft({ commit, message, files: changed, queue: remaining });
      await refreshGit(root);
    } catch (reason) {
      setError(String(reason));
      await refreshGit(root);
      if ((await invoke<Conflict[]>("git_conflicts", { root })).length) navigate("conflicts");
    } finally {
      setBusy(false);
    }
  };

  const finishRevert = async () => {
    if (!revertDraft) return;
    const remaining = revertDraft.queue;
    if (await execute("git_revert_finish", { message: revertDraft.message })) {
      setRevertDraft(null);
      if (remaining.length) await startRevert(remaining);
    }
  };

  const inspectDelete = async () => {
    if (!comparison) return;
    try {
      setDeletePreview(await invoke("git_delete_preview", { root, branch: comparison.selected }));
    } catch (reason) {
      setError(String(reason));
    }
  };

  const confirmDelete = async () => {
    if (!deletePreview) return;
    const protectedBranch = deletePreview.blocked?.startsWith("protected") ?? false;
    if (deletePreview.blocked && !protectedBranch) return setError(deletePreview.blocked);
    const actionName = protectedBranch ? "Unprotect and delete" : deletePreview.merged ? "Delete" : "Delete anyway";
    if (!confirm(`${actionName} local branch ${deletePreview.branch} at ${deletePreview.revision}?\nUndo lasts only for this Shorikai session and does not restore the original branch reflog.`)) return;
    if (await execute("git_delete_branch", {
      branch: deletePreview.branch,
      force: !deletePreview.merged,
      unprotect: protectedBranch,
    })) setDeletePreview(null);
  };

  const undoDelete = async () => {
    setBusy(true);
    try {
      await invoke("git_undo_delete", { root, alternate: null });
      await refreshGit(root);
      await load();
    } catch (reason) {
      const text = String(reason);
      if (text.includes("already in use")) {
        const alternate = prompt("The original branch name is in use. Restore as:");
        if (alternate) await execute("git_undo_delete", { alternate });
      } else setError(text);
    } finally {
      setBusy(false);
    }
  };

  const executePush = async (forceLease: boolean) => {
    if (!push) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("git_push_execute", { root, forceLease, expected: forceLease ? push.expected_remote : null });
      await refreshGit(root);
      await load();
    } catch (reason) {
      const text = String(reason);
      if (/(rejected|stale|remote revision changed|fetch first)/i.test(text)) navigate("compare", `${push.remote}/${push.branch}`);
      else setError(text);
    } finally {
      setBusy(false);
    }
  };

  const chooseConflict = (item: Conflict) => {
    setConflict(item);
    setResult(item.working);
  };

  const applyFilters = () => {
    setAppliedFilters(filters);
    setTarget("");
    setOffset(0);
    if (offset === 0) queueMicrotask(() => void load());
  };

  const clearFilter = (key: keyof Filters) => {
    const next = { ...appliedFilters, [key]: "" };
    setFilters(next);
    setAppliedFilters(next);
    setTarget("");
    setOffset(0);
  };

  const renderBranches = () => (
    <div className="git-cockpit-page">
      <div className="git-cockpit-toolbar">
        <input placeholder="Search branches" value={branchSearch} onChange={(event) => setBranchSearch(event.target.value)} />
        <button disabled={busy} onClick={fetchBranches}>{busy ? "Fetching…" : "Fetch"}</button>
        <button onClick={() => {
          const name = prompt("New branch name");
          if (name) void execute("git_branch_create", { name, start: null, switch: true });
        }}>New Branch</button>
        {lastFetched && <small>Last fetched {new Date(lastFetched).toLocaleTimeString()}</small>}
      </div>
      {error && <div className="git-recovery-actions"><button onClick={() => bus.openCliTerminal("git fetch", "Git authentication")}>Open Terminal</button><button onClick={fetchBranches}>Retry</button></div>}
      {([false, true] as const).map((remote) => (
        <section key={String(remote)}>
          <h3>{remote ? "Remote branches" : "Local branches"}</h3>
          {branches.filter((branch) => Boolean(branch.remote) === remote && branch.name.toLowerCase().includes(branchSearch.toLowerCase())).map((branch) => (
            <div className="git-branch-row" key={branch.name}>
              <span>{branch.current ? "● " : ""}{branch.name}</span>
              <small>{branch.default ? "default · " : ""}{branch.protected ? "protected · " : ""}{branch.worktree ? `worktree: ${branch.worktree}` : branch.upstream ?? ""}</small>
              {!branch.current && <button onClick={() => checkout(branch, false)}>Checkout</button>}
              {!branch.current && <button onClick={() => navigate("compare", branch.name)}>Compare</button>}
            </div>
          ))}
        </section>
      ))}
    </div>
  );

  const renderHistory = () => (
    <div className="git-history-layout">
      <aside className="git-ref-rail">
        <h3>Repository history filters</h3>
        <input placeholder="Refs (comma-separated), or exact hash" value={filters.revision} onChange={(event) => setFilters({ ...filters, revision: event.target.value })} />
        <input placeholder="Message / regex" value={filters.message} onChange={(event) => setFilters({ ...filters, message: event.target.value })} />
        <input placeholder="Author name or email" value={filters.author} onChange={(event) => setFilters({ ...filters, author: event.target.value })} />
        <input placeholder="Literal repository path" value={filters.path} onChange={(event) => setFilters({ ...filters, path: event.target.value })} />
        <label>Commit date after<input type="date" value={filters.after} onChange={(event) => setFilters({ ...filters, after: event.target.value })} /></label>
        <label>Commit date before<input type="date" value={filters.before} onChange={(event) => setFilters({ ...filters, before: event.target.value })} /></label>
        <button onClick={applyFilters}>Query Git</button>
        <button onClick={() => { setFilters(EMPTY_FILTERS); setAppliedFilters(EMPTY_FILTERS); setTarget(""); setOffset(0); }}>Clear all</button>
        <div className="git-filter-chips">
          {(Object.entries(appliedFilters) as [keyof Filters, string][]).filter(([, value]) => value).map(([key, value]) => (
            <button key={key} onClick={() => clearFilter(key)}>{key}: {value} ×</button>
          ))}
        </div>
        <h3>Refs</h3>
        <div className="git-history-refs">
          {branches.map((branch) => <button key={branch.name} onClick={() => { const next = { ...filters, revision: branch.name }; setFilters(next); setAppliedFilters(next); setTarget(""); setOffset(0); }}>{branch.current ? "● " : ""}{branch.name}</button>)}
        </div>
      </aside>
      <main>
        <CommitRows commits={commits} selected={selected?.hash} marked={marked} onSelect={loadCommit} onMark={toggleMarked} />
        {commits.length >= 200 && <button className="git-load-more" onClick={() => setOffset(offset + 200)}>Load older commits</button>}
      </main>
      <aside className="git-inspector">
        {selected ? (
          <>
            <h2>{selected.subject}</h2>
            <p>{selected.author} &lt;{selected.email}&gt;</p>
            <p>Commit date {date(selected.timestamp)} · <code>{selected.hash}</code></p>
            <div className="git-cockpit-toolbar">
              <button onClick={() => execute("git_cherry_pick", { commits: selectedOperations().map((commit) => commit.hash) })}>Preview & cherry-pick {selectedOperations().length > 1 ? `${selectedOperations().length} commits` : ""}</button>
              <button onClick={() => startRevert()}>Review revert {selectedOperations().length > 1 ? `${selectedOperations().length} commits` : ""}</button>
              <button onClick={() => {
                const name = prompt(`Branch from ${short(selected.hash)}`);
                if (name) void execute("git_branch_create", { name, start: selected.hash, switch: false });
              }}>Create branch</button>
            </div>
            <FileRows
              files={files}
              onSelect={(file) => previewRevisionFile(selected.hash, file)}
              onOpen={(file) => previewRevisionFile(selected.hash, file, true)}
              action={(file) => <button onClick={() => { setFilePath(file.path); navigate("file", file.path); }}>History</button>}
            />
            <DiffPreview diff={diff} />
          </>
        ) : <div className="git-cockpit-empty">Select a commit.</div>}
        {revertDraft && (
          <div className="git-revert-review">
            <h3>Review inverse changes for {short(revertDraft.commit.hash)}</h3>
            <textarea value={revertDraft.message} onChange={(event) => setRevertDraft({ ...revertDraft, message: event.target.value })} />
            <FileRows files={revertDraft.files} action={(file) => (
              <button onClick={async () => {
                if (await execute("git_revert_exclude", { path: file.path }, async () => {})) {
                  setRevertDraft({ ...revertDraft, files: revertDraft.files.filter((candidate) => candidate.path !== file.path) });
                }
              }}>Exclude</button>
            )} />
            <button onClick={finishRevert}>Create revert commit</button>
            {revertDraft.queue.length > 0 && <small>{revertDraft.queue.length} more selected commits will be reviewed separately.</small>}
          </div>
        )}
      </aside>
    </div>
  );

  const rebaseInvalid = rebasePlan.some((step, index) =>
    (step.action === "squash" || step.action === "fixup")
      && !rebasePlan.slice(0, index).some((previous) => previous.action !== "drop"));

  const renderCompare = () => (
    <div className="git-cockpit-page">
      <div className="git-cockpit-toolbar">
        <input placeholder="Branch or ref" value={target} onChange={(event) => setTarget(event.target.value)} />
        <button onClick={load}>Compare</button>
      </div>
      {comparison && (
        <>
          <h2>{comparison.current} ↔ {comparison.selected}</h2>
          <p className="git-topology">
            {comparison.topology} · merge base {comparison.merge_base ? short(comparison.merge_base) : "none"} · {comparison.current_only.length} ahead / {comparison.selected_only.length} behind
            {comparison.merge_ff && ` · merge.ff=${comparison.merge_ff}`}
          </p>
          <p>
            {comparison.topology === "identical" && "Branches point to the same history; no action is required."}
            {comparison.topology === "fast-forward" && (comparison.merge_ff === "false" ? "Repository policy requires a reviewable merge commit." : `Fast-forward moves ${comparison.current} directly to ${comparison.selected}.`)}
            {comparison.topology === "already-contained" && `${comparison.selected} is already contained by ${comparison.current}.`}
            {comparison.topology === "divergent" && (comparison.merge_ff === "only" ? "Repository policy blocks this divergent merge." : "A true two-parent merge will pause with staged results and a proposed message.")}
          </p>
          <div className="git-cockpit-toolbar">
            <button onClick={() => execute("git_checkout", { target: comparison.selected, smart: false })}>Checkout</button>
            <button onClick={() => execute("git_checkout", { target: comparison.selected, smart: true })}>Smart Checkout</button>
            <button onClick={() => {
              const name = prompt(`Branch from ${comparison.selected}`);
              if (name) void execute("git_branch_create", { name, start: comparison.selected, switch: false });
            }}>Create Branch</button>
            <button disabled={!comparison.merge_base || comparison.merge_ff === "only" && comparison.topology === "divergent"} onClick={() => execute("git_merge", { branch: comparison.selected })}>Merge into {comparison.current}</button>
            <button onClick={() => execute("git_rebase", { upstream: comparison.selected, autostash: false })}>Rebase</button>
            <button onClick={() => execute("git_rebase", { upstream: comparison.selected, autostash: true })}>Rebase with autostash</button>
            <button onClick={() => setRebasePlan([...comparison.current_only].reverse().map((commit) => ({ action: "pick", commit: commit.hash, message: null, subject: commit.subject })))}>Interactive Plan</button>
            <button className="danger" onClick={inspectDelete}>Delete…</button>
            <button onClick={undoDelete}>Undo deletion</button>
          </div>
          <p className="git-preflight">Rebase rewrites {comparison.current_only.length} commits after {comparison.merge_base ? short(comparison.merge_base) : "no common base"}. Dirty tree: {git?.files.length ?? 0} paths. {git?.upstream ? "A rewritten tracked branch will require force-with-lease." : "No tracked upstream requires reconciliation."}</p>
          {deletePreview && (
            <section className="git-delete-preview">
              <h3>Delete local branch {deletePreview.branch}</h3>
              {deletePreview.blocked && <p>{deletePreview.blocked}</p>}
              {!deletePreview.merged && <><p>{deletePreview.unique_commits.length} commits are unique to this branch.</p><CommitRows commits={deletePreview.unique_commits} /></>}
              <p>Refs also containing its tip: {deletePreview.containing_refs.join(", ") || "none"}.</p>
              <p>Undo expires with this Shorikai session and does not restore the original branch reflog. Remote deletion is unavailable.</p>
              <button className="danger" disabled={Boolean(deletePreview.blocked && !deletePreview.blocked.startsWith("protected"))} onClick={confirmDelete}>{deletePreview.blocked?.startsWith("protected") ? "Unprotect and delete" : deletePreview.merged ? "Delete" : "Delete anyway"}</button>
              <button onClick={() => setDeletePreview(null)}>Cancel</button>
            </section>
          )}
          {rebasePlan.length > 0 && (
            <section className="git-rebase-plan">
              <h3>Interactive rebase onto {comparison.selected} · oldest to newest</h3>
              {rebasePlan.map((step, index) => (
                <div className="git-rebase-step" key={step.commit}>
                  <select value={step.action} onChange={(event) => setRebasePlan(rebasePlan.map((item, itemIndex) => itemIndex === index ? { ...item, action: event.target.value as RebaseStep["action"] } : item))}>
                    {["pick", "reword", "squash", "fixup", "drop"].map((actionName) => <option key={actionName}>{actionName}</option>)}
                  </select>
                  <button disabled={index === 0} onClick={() => { const next = [...rebasePlan]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setRebasePlan(next); }}>↑</button>
                  <button disabled={index === rebasePlan.length - 1} onClick={() => { const next = [...rebasePlan]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; setRebasePlan(next); }}>↓</button>
                  <code>{short(step.commit)}</code><span>{step.subject}</span>
                  {(step.action === "reword" || step.action === "squash") && <input placeholder="Resulting commit message" value={step.message ?? step.subject} onChange={(event) => setRebasePlan(rebasePlan.map((item, itemIndex) => itemIndex === index ? { ...item, message: event.target.value } : item))} />}
                </div>
              ))}
              <div className="git-rebase-summary">
                {rebasePlan.map((step) => <span key={step.commit}>{short(step.commit)} → {step.action === "drop" ? "disappears" : step.action === "squash" || step.action === "fixup" ? "combines with previous" : "new identity"}</span>)}
              </div>
              {rebaseInvalid && <p className="git-cockpit-error">Squash and Fixup require a preceding non-dropped commit.</p>}
              <button onClick={() => setRebasePlan([])}>Cancel</button>
              <button disabled={rebaseInvalid} onClick={() => execute("git_interactive_rebase", { base: comparison.selected, steps: rebasePlan.map(({ action: actionName, commit, message }) => ({ action: actionName, commit, message })) }, async () => setRebasePlan([]))}>Start interactive rebase</button>
            </section>
          )}
          <div className="git-compare-columns">
            <section><h3>Only {comparison.current}</h3><CommitRows commits={comparison.current_only} /></section>
            <section><h3>Only {comparison.selected}</h3><CommitRows commits={comparison.selected_only} /></section>
            <section><h3>Net changed files</h3><FileRows files={comparison.files} /></section>
          </div>
        </>
      )}
    </div>
  );

  const renderStashes = () => (
    <div className="git-cockpit-page">
      <div className="git-cockpit-toolbar">
        <input placeholder="Stash message" value={stashMessage} onChange={(event) => setStashMessage(event.target.value)} />
        <label><input type="checkbox" checked={stashUntracked} onChange={(event) => setStashUntracked(event.target.checked)} /> include untracked</label>
        <button onClick={() => execute("git_stash_create", { message: stashMessage, untracked: stashUntracked })}>Create stash</button>
      </div>
      {stashes.map((stash) => (
        <section className="git-stash" key={stash.reference}>
          <h3>{stash.reference} · {stash.message}</h3>
          <small>{stash.branch} · {date(stash.timestamp)}{stash.message.startsWith("Shorikai smart checkout") ? " · recoverable smart-checkout stash" : ""}</small>
          <div className="git-cockpit-toolbar">
            <button onClick={() => execute("git_stash_action", { action: "apply", reference: stash.reference })}>Apply</button>
            <button onClick={() => execute("git_stash_action", { action: "pop", reference: stash.reference })}>Pop</button>
            <button className="danger" onClick={() => confirm(`Drop ${stash.reference}: ${stash.message}?`) && execute("git_stash_action", { action: "drop", reference: stash.reference })}>Drop</button>
          </div>
          <FileRows files={stash.files} onSelect={(file) => previewRevisionFile(stash.revision, file)} onOpen={(file) => previewRevisionFile(stash.revision, file, true)} />
        </section>
      ))}
      <DiffPreview diff={diff} />
    </div>
  );

  const renderConflicts = () => (
    <div className="git-conflict-layout">
      <aside>
        {conflicts.map((item) => <button className={conflict?.path === item.path ? "active" : ""} key={item.path} onClick={() => chooseConflict(item)}>{item.path} {item.binary ? "(binary)" : ""}</button>)}
        {conflicts.length === 0 && <div className="git-cockpit-empty">All conflicts resolved. The parent operation can continue.</div>}
      </aside>
      {conflict ? conflict.binary ? (
        <main><h2>{conflict.path}</h2><p>Binary conflict: choose one complete indexed side.</p><button onClick={() => execute("git_resolve", { path: conflict.path, content: null, side: "current" })}>Use current</button><button onClick={() => execute("git_resolve", { path: conflict.path, content: null, side: "incoming" })}>Use incoming</button></main>
      ) : (
        <main>
          <div className="git-merge-editor">
            <label>{git?.branch ?? "Current branch"}<textarea readOnly value={conflict.current} /><details><summary>Base revision</summary><pre>{conflict.base}</pre></details></label>
            <label>Result<textarea value={result} onChange={(event) => setResult(event.target.value)} /></label>
            <label>Incoming branch<textarea readOnly value={conflict.incoming} /></label>
          </div>
          <div className="git-cockpit-toolbar">
            <button onClick={() => setResult(conflict.working)}>Apply non-conflicting Git result</button>
            <button onClick={() => setResult(conflict.current)}>Accept current</button>
            <button onClick={() => setResult(conflict.incoming)}>Accept incoming</button>
            <button onClick={() => setResult(`${conflict.current}${conflict.incoming}`)}>Accept both</button>
            <button onClick={() => execute("git_resolve", { path: conflict.path, content: result, side: null }, async () => { setConflict(null); await load(); })}>Save & Mark Resolved</button>
          </div>
        </main>
      ) : <main className="git-cockpit-empty">Select a conflicted path.</main>}
    </div>
  );

  const renderPush = () => (
    <div className="git-cockpit-page">
      {push && (
        <>
          <h2>{push.rewritten ? "History rewrite: " : "Push "}{push.local} → {push.remote}/{push.branch}</h2>
          <p>Local tip {git?.head ?? "unknown"} · fetched remote tip {push.expected_remote ?? "branch does not exist"}.</p>
          <p>{push.creates ? `Creates ${push.remote}/${push.branch} and sets it as upstream.` : `${push.outgoing.length} outgoing commits.`}</p>
          <CommitRows commits={push.outgoing} />
          {push.rewritten && <><h3>Remote commits that will stop being reachable</h3><CommitRows commits={push.removed} /></>}
          <h3>Affected files</h3><FileRows files={push.files} />
          <div className="git-cockpit-toolbar">
            {!push.rewritten && <button onClick={() => executePush(false)}>Push {push.remote}/{push.branch}</button>}
            {push.rewritten && push.force_allowed && push.expected_remote && (
              <button className="danger" onClick={() => confirm(`Force-with-lease ${push.local} to ${push.remote}/${push.branch}?\nExpected fetched remote tip: ${push.expected_remote}\n${push.removed.length} remote commits will stop being reachable.`) && executePush(true)}>Force with lease to {push.remote}/{push.branch}</button>
            )}
            {push.rewritten && !push.force_allowed && <span>Repository policy protects this remote branch.</span>}
            <button onClick={() => bus.openCliTerminal(`git push ${push.remote} HEAD:${push.branch}`, "Git push authentication")}>Open Terminal</button>
            <button onClick={load}>Retry preview</button>
            {push.expected_remote && <button onClick={() => navigate("compare", `${push.remote}/${push.branch}`)}>Compare remote</button>}
          </div>
        </>
      )}
    </div>
  );

  const renderFileHistory = () => (
    <div className="git-cockpit-page">
      <div className="git-cockpit-toolbar">
        <input placeholder="Repository-relative file path" value={filePath} onChange={(event) => setFilePath(event.target.value)} />
        <button onClick={load}>File History</button>
        <button onClick={async () => {
          try { setBlame(await invoke("git_blame", { root, path: filePath, ignoreWhitespace: false })); }
          catch (reason) { setError(String(reason)); }
        }}>Blame on demand</button>
      </div>
      {fileHistory && <><p>Previous paths: {fileHistory.previous_paths.join(", ") || "none"}</p><CommitRows commits={fileHistory.commits} selected={selected?.hash} onSelect={loadCommit} /></>}
      {blame.length > 0 && <div className="git-blame-list">{blame.map((line) => <button key={line.line} onClick={() => navigate("history", line.hash)}><code>{String(line.line).padStart(4)} {short(line.hash)}</code><span>{line.author} &lt;{line.email}&gt;</span><small>{date(line.timestamp)}</small><span>{line.text}</span></button>)}</div>}
    </div>
  );

  return (
    <div className="git-cockpit">
      <div className="git-cockpit-tabs">
        {(["branches", "history", "compare", "stashes", "conflicts", "push", "file"] as Section[]).map((item) => <button key={item} className={section === item ? "active" : ""} onClick={() => navigate(item)}>{item}</button>)}
        <span /><button title="Refresh" onClick={load}>↻</button>
      </div>
      {error && <div className="git-cockpit-error">{error}</div>}
      {section === "branches" && renderBranches()}
      {section === "history" && renderHistory()}
      {section === "compare" && renderCompare()}
      {section === "stashes" && renderStashes()}
      {section === "conflicts" && renderConflicts()}
      {section === "push" && renderPush()}
      {section === "file" && renderFileHistory()}
    </div>
  );
}
