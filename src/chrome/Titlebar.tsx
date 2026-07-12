import { useState, useSyncExternalStore } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  addProject,
  actionsFor,
  closeProject,
  deleteProjectAction,
  getProjects,
  setActive,
  subscribeProjects,
  upsertProjectAction,
} from "../projects";
import type { ProjectAction } from "../projects";
import {
  clearBackgroundImage,
  setBackgroundImage,
  setBackgroundOpacity,
  useIdeBackground,
} from "../background";
import { getGitFor, subscribeGit } from "../gitStore";
import { bus } from "../bus";
import { hasShortcutModifier, normalizeShortcut } from "../actions";
import { setVimMode, useVimMode } from "../vimMode";
import {
  setRelativeLineNumbers,
  useRelativeLineNumbers,
} from "../editorSettings";

const BranchIcon = (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="8" r="2.4" />
    <path d="M6 8.4v7.2M8.4 6H14a3 3 0 0 1 3 3" />
  </svg>
);

const ActionIcons = ["⌘", "▶", "✓", "⚡", "◆", "●", "▲", "▣"];

function ActionsMenu(props: { root: string }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectAction | null>(null);
  const [draft, setDraft] = useState({ icon: "⌘", name: "", command: "", shortcut: "" });
  const actions = useSyncExternalStore(subscribeProjects, () => actionsFor(props.root));
  const startEdit = (action?: ProjectAction) => {
    setEditing(action ?? { id: "", icon: "⌘", name: "", command: "", shortcut: "" });
    setDraft({
      icon: action?.icon ?? "⌘",
      name: action?.name ?? "",
      command: action?.command ?? "",
      shortcut: action?.shortcut ?? "",
    });
  };
  const saveDraft = () => {
    const shortcut = normalizeShortcut(draft.shortcut);
    if (!draft.name.trim() || !draft.command.trim()) return;
    if (shortcut && !hasShortcutModifier(shortcut)) return;
    upsertProjectAction(props.root, {
      id: editing?.id || undefined,
      icon: draft.icon,
      name: draft.name,
      command: draft.command,
      shortcut,
    });
    setEditing(null);
  };
  return (
    <div className="project-actions">
      <button
        className={`project-actions-button${actions.length ? " project-actions-button-has-items" : ""}`}
        title="Project actions"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <span className="project-actions-glyph">⌘</span>
        <span>Actions</span>
      </button>
      {open && (
        <div className="project-actions-menu" onClick={(e) => e.stopPropagation()}>
          {actions.map((action) => (
            <div className="project-action-row" key={action.id}>
              <button
                className="project-action-run"
                title={action.command}
                onClick={() => {
                  setOpen(false);
                  bus.openCliTerminal(action.command, action.name);
                }}
              >
                <span className="project-action-label">
                  <span className="project-action-icon">{action.icon ?? "⌘"}</span>
                  <span>{action.name}</span>
                </span>
                {action.shortcut && <span className="project-action-key">{action.shortcut}</span>}
              </button>
              <button title="Edit action" onClick={() => startEdit(action)}>✎</button>
              <button title="Delete action" onClick={() => deleteProjectAction(props.root, action.id)}>×</button>
            </div>
          ))}
          {actions.length === 0 && <div className="project-actions-empty">No actions</div>}
          {editing && (
            <div className="project-action-form">
              <div className="project-action-icon-grid">
                {ActionIcons.map((icon) => (
                  <button
                    key={icon}
                    className={draft.icon === icon ? "project-action-icon-active" : ""}
                    title={`Use ${icon}`}
                    onClick={() => setDraft({ ...draft, icon })}
                  >
                    {icon}
                  </button>
                ))}
              </div>
              <input
                autoFocus
                placeholder="Name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
              />
              <input
                placeholder="Command"
                value={draft.command}
                onChange={(e) => setDraft({ ...draft, command: e.currentTarget.value })}
              />
              <input
                placeholder="Shortcut, e.g. Cmd+Shift+T"
                value={draft.shortcut}
                onChange={(e) => setDraft({ ...draft, shortcut: e.currentTarget.value })}
              />
              <div className="project-action-form-buttons">
                <button onClick={() => setEditing(null)}>Cancel</button>
                <button onClick={saveDraft}>Save</button>
              </div>
            </div>
          )}
          <button className="project-action-add" onClick={() => startEdit()}>
            + Add action
          </button>
        </div>
      )}
    </div>
  );
}

function SettingsWindow(props: { onClose: () => void }) {
  const bg = useIdeBackground();
  const vim = useVimMode();
  const relativeLines = useRelativeLineNumbers();
  const pick = async () => {
    const file = await openDialog({
      multiple: false,
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"] },
      ],
    });
    if (typeof file === "string") setBackgroundImage(file);
  };

  return (
    <div className="settings-backdrop" onMouseDown={props.onClose}>
      <div className="settings-window" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span>Settings</span>
          <button title="Close settings" onClick={props.onClose}>
            ×
          </button>
        </div>
        <label className="settings-row">
          <span>
            <b>Vim mode</b>
          </span>
          <input
            type="checkbox"
            checked={vim}
            onChange={(e) => setVimMode(e.currentTarget.checked)}
          />
        </label>
        <label className="settings-row">
          <span>
            <b>Relative lines</b>
          </span>
          <input
            type="checkbox"
            checked={relativeLines}
            onChange={(e) => setRelativeLineNumbers(e.currentTarget.checked)}
          />
        </label>
        <div className="settings-section">
          <div className="settings-section-title">Background image</div>
          <div className="settings-actions">
            <button onClick={pick}>Pick image</button>
            <button disabled={!bg.path} onClick={clearBackgroundImage}>
              Clear
            </button>
          </div>
          {bg.path && <div className="settings-path">{bg.path.split("/").pop()}</div>}
          <label className="settings-opacity">
            <span>Opacity</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={bg.opacity}
              onChange={(e) => setBackgroundOpacity(Number(e.currentTarget.value))}
            />
            <span>{Math.round(bg.opacity * 100)}%</span>
          </label>
        </div>
      </div>
    </div>
  );
}

export function Titlebar() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { projects, active, statuses } = useSyncExternalStore(
    subscribeProjects,
    getProjects,
  );
  const branch = useSyncExternalStore(subscribeGit, () =>
    active ? (getGitFor(active)?.branch ?? "") : "",
  );

  const pick = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
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
                <button className="tab-branch" title="Browse branches" onClick={(event) => { event.stopPropagation(); bus.openGit("branches"); }}>
                  {BranchIcon}
                  {branch}
                </button>
              )}
              {isActive && <ActionsMenu root={p.root} />}
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
      <button
        className="settings-button"
        title="Settings"
        onClick={() => setSettingsOpen(true)}
      >
        ⚙
      </button>
      {settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
