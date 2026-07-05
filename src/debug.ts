// Debug tracer state: gutter breakpoints, paused location, debug-terminal
// creation. Rides the dap-core event stream; full debug UI lands with #16.
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

type Snapshot = { paused: Paused | null; error: string | null; starting: boolean };

const breakpoints = new Map<string, Set<number>>();
let snapshot: Snapshot = { paused: null, error: null, starting: false };
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
      case "stopped":
        patch({
          paused: {
            sessionId: ev.session_id,
            threadId: ev.thread_id ?? 1,
            path: ev.path ?? null,
            line: ev.line ?? null,
          },
        });
        if (ev.path && ev.line) bus.openFile(ev.path, ev.line);
        break;
      case "continued":
      case "session_ended":
        if (snapshot.paused?.sessionId === ev.session_id) patch({ paused: null });
        break;
      case "error":
        patch({ error: ev.message ?? "debug error" });
        break;
    }
  });
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

export function dismissDebugError() {
  patch({ error: null });
}
