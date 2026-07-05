import { useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  addProject,
  closeProject,
  getProjects,
  setActive,
  subscribeProjects,
} from "../projects";
import { getGitFor, subscribeGit } from "../gitStore";

const BranchIcon = (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="8" r="2.4" />
    <path d="M6 8.4v7.2M8.4 6H14a3 3 0 0 1 3 3" />
  </svg>
);

export function Titlebar() {
  const { projects, active, statuses } = useSyncExternalStore(
    subscribeProjects,
    getProjects,
  );
  const branch = useSyncExternalStore(subscribeGit, () =>
    active ? (getGitFor(active)?.branch ?? "") : "",
  );

  const pick = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") addProject(dir);
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-tabs">
        {projects.map((p) => {
          const isActive = p.root === active;
          const status = statuses.get(p.root) ?? "idle";
          return (
            <div
              key={p.root}
              className={`project-tab${isActive ? " project-tab-active" : ""}`}
              title={p.root}
              onClick={() => setActive(p.root)}
            >
              {isActive ? (
                <span className="dot dot-idle" />
              ) : status === "working" ? (
                <span className="tab-spinner" />
              ) : status === "attention" ? (
                <span className="dot dot-attention" />
              ) : null}
              <span>{p.name}</span>
              {isActive && branch && (
                <span className="tab-branch">
                  {BranchIcon}
                  {branch}
                </span>
              )}
              {projects.length > 1 && (
                <span
                  className="tab-close"
                  title="Close project"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeProject(p.root);
                  }}
                >
                  ×
                </span>
              )}
            </div>
          );
        })}
        <div className="project-tab-new" title="Open project…" onClick={pick}>
          +
        </div>
      </div>
    </div>
  );
}
