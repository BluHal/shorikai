// Debug state: gutter breakpoints, paused location, frames, console, and the
// debug-terminal creation flow. Rides the dap-core event stream.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bus } from "./bus";
import { activeWorkspace, getProjects } from "./projects";

export type Paused = {
  sessionId: number;
  threadId: number;
  path: string | null;
  line: number | null;
};

export type Frame = { id: number; name: string; path: string | null; line: number | null };
export type Scope = { name: string; variablesReference: number; expensive?: boolean };
export type Variable = {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
};
export type ConsoleLine =
  | { kind: "input"; text: string }
  | { kind: "result"; text: string }
  | { kind: "error"; text: string }
  | { kind: "output"; category: string; text: string };

type Snapshot = {
  paused: Paused | null;
  error: string | null;
  starting: boolean;
  frames: Frame[];
  selectedFrame: number | null;
  consoleLines: ConsoleLine[];
  /// bumps on every stop so panels refetch scopes/variables
  stopNonce: number;
};

const breakpoints = new Map<string, Set<number>>();
let snapshot: Snapshot = {
  paused: null,
  error: null,
  starting: false,
  frames: [],
  selectedFrame: null,
  consoleLines: [],
  stopNonce: 0,
};
const subs = new Set<() => void>();
const emit = () => subs.forEach((fn) => fn());
const patch = (p: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...p };
  emit();
};

export const getDebug = () => snapshot;
export const getBreakpoints = (path: string) => breakpoints.get(path);
export function subscribeDebug(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

function pushConsole(line: ConsoleLine) {
  const lines = [...snapshot.consoleLines, line].slice(-500);
  patch({ consoleLines: lines });
}

type DapEvent = {
  kind: string;
  session_id: number;
  request_seq?: number;
  title?: string;
  cwd?: string;
  env?: Record<string, string>;
  thread_id?: number;
  reason?: string;
  path?: string | null;
  line?: number | null;
  category?: string;
  text?: string;
  message?: string;
};

let wired = false;
export function wireDebug() {
  if (wired) return;
  wired = true;
  listen<DapEvent>("dap:event", (e) => {
    const ev = e.payload;
    switch (ev.kind) {
      case "run_in_terminal":
        patch({ starting: false });
        activeWorkspace()?.addDebugTerminal({
          env: ev.env ?? {},
          title: ev.title || "debug",
          dapReply: { sessionId: ev.session_id, requestSeq: ev.request_seq ?? 0 },
        });
        break;
      case "stopped": {
        const paused: Paused = {
          sessionId: ev.session_id,
          threadId: ev.thread_id ?? 1,
          path: ev.path ?? null,
          line: ev.line ?? null,
        };
        patch({ paused, stopNonce: snapshot.stopNonce + 1 });
        if (ev.path && ev.line) bus.openFile(ev.path, ev.line);
        activeWorkspace()?.openDebugPane();
        void fetchFrames(paused);
        break;
      }
      case "continued":
      case "session_ended":
        if (snapshot.paused?.sessionId === ev.session_id) {
          patch({ paused: null, frames: [], selectedFrame: null });
        }
        break;
      case "output":
        if (ev.text?.trim()) {
          pushConsole({
            kind: "output",
            category: ev.category ?? "console",
            text: ev.text.replace(/\n$/, ""),
          });
        }
        break;
      case "error":
        patch({ error: ev.message ?? "debug error" });
        break;
    }
  });
}

async function fetchFrames(paused: Paused) {
  try {
    const frames = await invoke<Frame[]>("dap_stack_trace", {
      sessionId: paused.sessionId,
      threadId: paused.threadId,
    });
    if (snapshot.paused?.sessionId === paused.sessionId) {
      patch({ frames, selectedFrame: frames[0]?.id ?? null });
    }
  } catch {
    // session died mid-fetch
  }
}

export function selectFrame(id: number) {
  patch({ selectedFrame: id });
  const frame = snapshot.frames.find((f) => f.id === id);
  if (frame?.path && frame.line) bus.openFile(frame.path, frame.line);
}

export const fetchScopes = (frameId: number): Promise<Scope[]> => {
  const paused = snapshot.paused;
  if (!paused) return Promise.resolve([]);
  return invoke<Scope[]>("dap_scopes", {
    sessionId: paused.sessionId,
    frameId,
  }).catch(() => []);
};

export const fetchVariables = (variablesReference: number): Promise<Variable[]> => {
  const paused = snapshot.paused;
  if (!paused) return Promise.resolve([]);
  return invoke<Variable[]>("dap_variables", {
    sessionId: paused.sessionId,
    variablesReference,
  }).catch(() => []);
};

export async function evaluateExpression(expression: string) {
  const { paused, selectedFrame } = snapshot;
  pushConsole({ kind: "input", text: expression });
  if (!paused) {
    pushConsole({ kind: "error", text: "not paused" });
    return;
  }
  try {
    const res = await invoke<{ result?: string }>("dap_evaluate", {
      sessionId: paused.sessionId,
      expression,
      frameId: selectedFrame,
    });
    pushConsole({ kind: "result", text: res?.result ?? "" });
  } catch (err) {
    pushConsole({ kind: "error", text: String(err) });
  }
}

export function toggleBreakpoint(path: string, line: number) {
  const set = new Set(breakpoints.get(path) ?? []);
  if (set.has(line)) set.delete(line);
  else set.add(line);
  if (set.size) breakpoints.set(path, set);
  else breakpoints.delete(path);
  invoke("dap_set_breakpoints", {
    path,
    lines: [...set].sort((a, b) => a - b),
  }).catch(() => {});
  emit();
}

export async function startDebugTerminal() {
  const root = getProjects().active;
  if (!root || snapshot.starting) return;
  patch({ starting: true, error: null });
  try {
    await invoke("dap_start_debug_terminal", { root });
    // terminal pane arrives via the run_in_terminal event
  } catch (err) {
    patch({ starting: false, error: String(err) });
  }
}

export function continuePaused() {
  const paused = snapshot.paused;
  if (!paused) return;
  invoke("dap_continue", {
    sessionId: paused.sessionId,
    threadId: paused.threadId,
  }).catch(() => {});
}

export function step(kind: "next" | "stepIn" | "stepOut") {
  const paused = snapshot.paused;
  if (!paused) return;
  invoke("dap_step", {
    sessionId: paused.sessionId,
    threadId: paused.threadId,
    kind,
  }).catch(() => {});
}

/// last session we saw pause; pause targets it while running
let lastSession: { sessionId: number; threadId: number } | null = null;
subscribeDebug(() => {
  if (snapshot.paused) {
    lastSession = {
      sessionId: snapshot.paused.sessionId,
      threadId: snapshot.paused.threadId,
    };
  }
});

export function pauseRunning() {
  if (snapshot.paused || !lastSession) return;
  invoke("dap_step", { ...lastSession, kind: "pause" }).catch(() => {});
}

export function dismissDebugError() {
  patch({ error: null });
}
