import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bus } from "../bus";
import { getGitFor, refreshGit, subscribeGit } from "../gitStore";
import { useProjectRoot } from "../projects";

const ContinueIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12h12M13 7l5 5-5 5" />
  </svg>
);

const AbortIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
    <path d="m9 9 6 6m0-6-6 6" />
  </svg>
);

const TerminalIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3m5 0h5" />
  </svg>
);

const ResolveIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="6" cy="6" r="2" />
    <circle cx="6" cy="18" r="2" />
    <circle cx="18" cy="8" r="2" />
    <path d="M6 8v8m2-10h5a5 5 0 0 1 5 5v5" />
  </svg>
);

const BranchIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="8" r="2" />
    <path d="M6 7v10m2-9h5a5 5 0 0 1 5 5v4" />
  </svg>
);

export function GitOperationBanner() {
  const root = useProjectRoot();
  const git = useSyncExternalStore(subscribeGit, () => getGitFor(root));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [namingBranch, setNamingBranch] = useState(false);
  const [branchName, setBranchName] = useState("");
  const operation = git?.operation;

  useEffect(() => {
    setError(null);
    setNamingBranch(false);
    setBranchName("");
  }, [operation?.kind]);

  if (!operation) return null;

  const run = (action: "continue" | "skip" | "abort") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    invoke("git_operation_action", { root, action }).then(
      async () => {
        await refreshGit(root);
        setBusy(false);
      },
      (reason) => {
        setError(String(reason));
        setBusy(false);
      },
    );
  };

  const createBranch = () => {
    if (busy || !branchName.trim()) return;
    setBusy(true);
    setError(null);
    invoke("git_create_branch", { root, name: branchName.trim() }).then(
      async () => {
        await refreshGit(root);
        setBusy(false);
      },
      (reason) => {
        setError(String(reason));
        setBusy(false);
      },
    );
  };

  const openTerminal = () => bus.openCliTerminal("git status", operation.title);
  const canUseNativeActions = ["merge", "cherry_pick", "revert", "rebase"].includes(operation.kind);

  return (
    <div className={`git-operation-banner git-operation-${operation.kind}`} role="status">
      <span className="git-operation-badge">{operation.label}</span>
      <strong>{operation.title}</strong>
      <span className={`git-operation-message${error ? " git-operation-error" : ""}`}>
        {error ?? operation.message}
      </span>
      <span className="git-operation-spacer" />

      {namingBranch ? (
        <form
          className="git-operation-branch-form"
          onSubmit={(event) => {
            event.preventDefault();
            createBranch();
          }}
        >
          <input
            autoFocus
            aria-label="New branch name"
            placeholder="branch-name"
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
          />
          <button
            className="git-operation-button primary"
            title="Create branch"
            disabled={busy || !branchName.trim()}
          >
            {BranchIcon}<span>Create</span>
          </button>
          <button
            type="button"
            className="git-operation-icon-button"
            title="Cancel"
            onClick={() => setNamingBranch(false)}
          >
            {AbortIcon}
          </button>
        </form>
      ) : operation.kind === "detached_head" ? (
        <button
          className="git-operation-button primary"
          title="Create branch"
          onClick={() => setNamingBranch(true)}
        >
          {BranchIcon}<span>Create Branch</span>
        </button>
      ) : operation.conflicts > 0 ? (
        <button
          className="git-operation-button primary"
          title="Resolve conflicts"
          onClick={() => bus.openGit("conflicts")}
        >
          {ResolveIcon}<span>Resolve</span>
        </button>
      ) : null}

      {canUseNativeActions && (
        <button
          className="git-operation-button"
          title="Continue operation"
          disabled={busy || !operation.can_continue}
          onClick={() => run("continue")}
        >
          {ContinueIcon}<span>Continue</span>
        </button>
      )}
      {operation.can_abort && (
        <button
          className="git-operation-button danger"
          title="Abort operation"
          disabled={busy}
          onClick={() => run("abort")}
        >
          {AbortIcon}<span>Abort</span>
        </button>
      )}
      {operation.can_skip && (
        <button className="git-operation-button" title="Skip current commit" disabled={busy} onClick={() => run("skip")}>
          <span>Skip</span>
        </button>
      )}
      {!operation.can_abort && !namingBranch && (
        <button className="git-operation-button" title="Open Terminal" onClick={openTerminal}>
          {TerminalIcon}<span>Open Terminal</span>
        </button>
      )}
    </div>
  );
}
