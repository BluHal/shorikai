import { useSyncExternalStore } from "react";
import { getProjects, subscribeProjects } from "../projects";
import { getLspRunning, getLspState, subscribeLsp } from "../lsp";
import { getGitFor, subscribeGit } from "../gitStore";
import { getVitals, subscribeVitals } from "../vitals";

const BranchIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="8" r="2.4" />
    <path d="M6 8.4v7.2M8.4 6H14a3 3 0 0 1 3 3" />
  </svg>
);

export function StatusBar() {
  const { active, statuses } = useSyncExternalStore(subscribeProjects, getProjects);
  const git = useSyncExternalStore(subscribeGit, () =>
    active ? getGitFor(active) : null,
  );
  const lsp = useSyncExternalStore(subscribeLsp, () =>
    active ? getLspState(active) : undefined,
  );
  const lspCount = useSyncExternalStore(subscribeLsp, () =>
    active ? getLspRunning(active) : 0,
  );
  const vitals = useSyncExternalStore(subscribeVitals, getVitals);

  const agent = active ? (statuses.get(active) ?? "idle") : "idle";
  const modified = git?.files.filter((f) => (f.unstaged ?? f.staged) === "M").length ?? 0;
  const untracked = git?.files.filter((f) => f.unstaged === "?").length ?? 0;
  const deleted = git?.files.filter((f) => (f.unstaged ?? f.staged) === "D").length ?? 0;
  const port = active ? vitals.ports.get(active)?.port : undefined;
  const cursor = vitals.cursor;

  return (
    <div className="statusbar">
      {git && (
        <div className="statusbar-seg statusbar-branch">
          {BranchIcon}
          <span>{git.branch}</span>
        </div>
      )}
      {git && (git.ahead > 0 || git.behind > 0 || git.files.length > 0) && (
        <div className="statusbar-seg statusbar-git">
          {(git.ahead > 0 || git.behind > 0) && (
            <>
              <span className="git-mod">↑{git.ahead}</span>
              <span className="git-add">↓{git.behind}</span>
              <span className="statusbar-dot-sep">·</span>
            </>
          )}
          {modified > 0 && <span className="git-mod">{modified}M</span>}
          {untracked > 0 && <span className="git-add">{untracked}U</span>}
          {deleted > 0 && <span className="git-del">{deleted}D</span>}
        </div>
      )}
      {lsp && (
        <div className={`statusbar-seg statusbar-lsp-${lsp}`}>
          {lsp === "running"
            ? `✓ ${lspCount} LSP`
            : lsp === "starting"
              ? "… LSP"
              : "✗ LSP restarting"}
        </div>
      )}
      <div className={`statusbar-seg statusbar-agent-${agent}`}>
        <span className="statusbar-agent-dot">⏺</span>
        {agent === "working"
          ? "agent: working…"
          : agent === "attention"
            ? "agent: needs attention"
            : "agent: idle"}
      </div>
      <div className="statusbar-right">
        {cursor && (
          <span className="statusbar-seg">
            Ln {cursor.line}, Col {cursor.col}
          </span>
        )}
        <span className="statusbar-seg">Spaces: 2</span>
        <span className="statusbar-seg">UTF-8</span>
        {cursor?.lang && <span className="statusbar-seg">{cursor.lang}</span>}
        {port != null && (
          <span className="statusbar-seg statusbar-port">
            <span className="statusbar-port-dot" />:{port} running
          </span>
        )}
      </div>
    </div>
  );
}
