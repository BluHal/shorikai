// session-state frontend: the project-tab registry. Each project is a full
// workspace; this module owns the list, the active tab, per-project agent
// status for the "who needs me" row, and persistence to disk.
import { createContext, useContext } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DockviewApi } from "dockview-react";
import { stopLsp } from "./lsp";

export type AgentStatus = "idle" | "working" | "attention";

export type Project = { root: string; name: string };
export type ProjectAction = {
  id: string;
  icon?: string;
  name: string;
  command: string;
  shortcut?: string;
};

export const ProjectCtx = createContext<string>("");
export const useProjectRoot = () => useContext(ProjectCtx);

type State = {
  projects: Project[];
  active: string | null;
  statuses: Map<string, AgentStatus>;
  actions: Map<string, ProjectAction[]>;
  loaded: boolean;
};

let state: State = {
  projects: [],
  active: null,
  statuses: new Map(),
  actions: new Map(),
  loaded: false,
};
const emptyActions: ProjectAction[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((fn) => fn());

export const getProjects = () => state;
export function subscribeProjects(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

const name = (root: string) => root.split("/").pop() ?? root;

// per-workspace dockview handlers, keyed by root
export type WorkspaceHandlers = {
  api: DockviewApi;
  openFile: (path: string, line?: number) => void;
  openDiff: (path: string, oldText: string, newText: string) => void;
  openChat: () => void;
  openTerminal: () => void;
  collapseEditor: () => void;
  toggleEditor: () => void;
  toggleTerminal: () => void;
  addDebugTerminal: (opts: {
    env: Record<string, string>;
    title: string;
    dapReply: { sessionId: number; requestSeq: number };
  }) => void;
  openDebugPane: () => void;
  openCliTerminal: (cmd: string, title: string) => void;
};
const handlers = new Map<string, WorkspaceHandlers>();
export const registerWorkspace = (root: string, h: WorkspaceHandlers) => {
  handlers.set(root, h);
};
export const unregisterWorkspace = (root: string) => {
  handlers.delete(root);
};
export const activeWorkspace = () =>
  state.active ? handlers.get(state.active) : undefined;

// layouts restored from disk, consumed once by each Workspace on mount
const savedLayouts = new Map<string, unknown>();
export const takeSavedLayout = (root: string) => {
  const l = savedLayouts.get(root);
  savedLayouts.delete(root);
  return l;
};

export async function initProjects() {
  if (state.loaded) return;
  let projects: Project[] = [];
  let active: string | null = null;
  try {
    const saved = await invoke<{
      projects?: { root: string }[];
      active?: string;
      layouts?: Record<string, unknown>;
      actions?: Record<string, ProjectAction[]>;
    } | null>("session_load");
    if (saved?.projects?.length) {
      projects = saved.projects.map((p) => ({ root: p.root, name: name(p.root) }));
      active = saved.active && projects.some((p) => p.root === saved.active)
        ? saved.active
        : projects[0].root;
      for (const [root, layout] of Object.entries(saved.layouts ?? {})) {
        savedLayouts.set(root, layout);
      }
      const actions = new Map<string, ProjectAction[]>();
      for (const [root, list] of Object.entries(saved.actions ?? {})) {
        actions.set(root, cleanActions(list));
      }
      state = { ...state, actions };
    }
  } catch {
    // fall through to default project
  }
  if (projects.length === 0) {
    const root = await invoke<string>("project_root");
    projects = [{ root, name: name(root) }];
    active = root;
  }
  state = { ...state, projects, active, loaded: true };
  emit();
}

export function addProject(root: string) {
  if (!state.projects.some((p) => p.root === root)) {
    state = {
      ...state,
      projects: [...state.projects, { root, name: name(root) }],
    };
  }
  setActive(root);
}

export function closeProject(root: string) {
  const projects = state.projects.filter((p) => p.root !== root);
  if (projects.length === 0) return; // last tab stays
  const active = state.active === root ? projects[0].root : state.active;
  const statuses = new Map(state.statuses);
  statuses.delete(root);
  state = { ...state, projects, active, statuses };
  invoke("ws_unwatch", { root }).catch(() => {});
  stopLsp(root);
  emit();
  saveSession();
}

export function setActive(root: string) {
  const statuses = new Map(state.statuses);
  // visiting a tab clears its "needs attention"
  if (statuses.get(root) === "attention") statuses.set(root, "idle");
  state = { ...state, active: root, statuses };
  emit();
  saveSession();
}

export function setAgentStatus(root: string, status: AgentStatus) {
  // a finished/blocked agent in the active tab is already being watched
  if (status === "attention" && state.active === root) status = "idle";
  const statuses = new Map(state.statuses);
  statuses.set(root, status);
  state = { ...state, statuses };
  emit();
}

function cleanActions(actions: ProjectAction[] = []) {
  return actions
    .filter((a) => a.name?.trim() && a.command?.trim())
    .map((a) => ({
      id: a.id || crypto.randomUUID(),
      icon: a.icon?.trim() || "⌘",
      name: a.name.trim(),
      command: a.command.trim(),
      shortcut: a.shortcut?.trim() || undefined,
    }));
}

export function actionsFor(root: string | null) {
  return root ? (state.actions.get(root) ?? emptyActions) : emptyActions;
}

export function upsertProjectAction(root: string, action: Omit<ProjectAction, "id"> & { id?: string }) {
  const next = cleanActions([{ ...action, id: action.id || crypto.randomUUID() }]);
  if (next.length === 0) return;
  const actions = new Map(state.actions);
  const list = actions.get(root) ?? [];
  actions.set(root, action.id ? list.map((a) => (a.id === action.id ? next[0] : a)) : [...list, next[0]]);
  state = { ...state, actions };
  emit();
  saveSession();
}

export function deleteProjectAction(root: string, id: string) {
  const actions = new Map(state.actions);
  actions.set(root, (actions.get(root) ?? []).filter((a) => a.id !== id));
  state = { ...state, actions };
  emit();
  saveSession();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function saveSession() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const layouts: Record<string, unknown> = {};
    const actions: Record<string, ProjectAction[]> = {};
    for (const p of state.projects) {
      actions[p.root] = state.actions.get(p.root) ?? [];
      const h = handlers.get(p.root);
      if (h) {
        try {
          layouts[p.root] = h.api.toJSON();
        } catch {
          // skip a workspace mid-teardown
        }
      }
    }
    invoke("session_save", {
      state: {
        projects: state.projects.map((p) => ({ root: p.root })),
        active: state.active,
        layouts,
        actions,
      },
    }).catch(() => {});
  }, 800);
}
