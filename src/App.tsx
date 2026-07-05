import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DockviewApi } from "dockview-react";
import { Titlebar } from "./chrome/Titlebar";
import { StatusBar } from "./chrome/StatusBar";
import { SearchOverlay } from "./chrome/SearchOverlay";
import { Workspace, addTerminal, isEditorish } from "./Workspace";
import { bus } from "./bus";
import { startGitStore } from "./gitStore";
import {
  continuePaused,
  dismissDebugError,
  getDebug,
  startDebugTerminal,
  subscribeDebug,
  wireDebug,
} from "./debug";
import {
  activeWorkspace,
  getProjects,
  initProjects,
  subscribeProjects,
} from "./projects";
import "dockview-react/dist/styles/dockview.css";
import "./App.css";

// panes call the bus; it always routes to the active workspace
bus.openFile = (path, line) => activeWorkspace()?.openFile(path, line);
bus.openDiff = (path, o, n) => activeWorkspace()?.openDiff(path, o, n);
bus.collapseEditor = () => activeWorkspace()?.collapseEditor();
bus.toggleTerminal = () => activeWorkspace()?.toggleTerminal();
bus.startDebugTerminal = () => startDebugTerminal();

function DebugOverlay() {
  const { paused, error, starting } = useSyncExternalStore(subscribeDebug, getDebug);
  if (!paused && !error && !starting) return null;
  return (
    <div className="debug-overlay">
      {error ? (
        <>
          <span className="debug-overlay-error">{error}</span>
          <button onClick={dismissDebugError}>dismiss</button>
        </>
      ) : starting ? (
        <>
          <span className="tool-spinner" />
          <span>starting debug session…</span>
        </>
      ) : (
        <>
          <span className="debug-overlay-paused">
            ⏸ paused
            {paused?.path
              ? ` at ${paused.path.split("/").pop()}:${paused.line ?? "?"}`
              : ""}
          </span>
          <button onClick={continuePaused}>▶ continue (F5)</button>
        </>
      )}
    </div>
  );
}

function cycleTab(api: DockviewApi, delta: number) {
  const group = api.activeGroup;
  if (!group || group.panels.length < 2) return;
  const idx = group.panels.indexOf(group.activePanel!);
  const n = group.panels.length;
  group.panels[(idx + delta + n) % n].api.setActive();
}

function cycleGroup(api: DockviewApi, delta: number) {
  const groups = api.groups;
  if (groups.length < 2 || !api.activeGroup) return;
  const idx = groups.indexOf(api.activeGroup);
  groups[(idx + delta + groups.length) % groups.length].focus();
}

function focusSplit(api: DockviewApi, dir: "left" | "right" | "up" | "down") {
  if (!api.activeGroup) return;
  api.adjacentGroupInDirection(api.activeGroup, dir)?.focus();
}

// ghostty-style bindings, by physical key (e.code) so they survive non-US layouts
function handleKey(e: KeyboardEvent): (() => void) | null {
  const ws = activeWorkspace();
  if (!ws) return null;
  const api = ws.api;
  const { metaKey: cmd, shiftKey: shift, altKey: alt, ctrlKey: ctrl } = e;
  const key = e.code;

  if (cmd && !shift && !alt && !ctrl) {
    if (key === "KeyP") return () => bus.openSearch("files");
    if (key === "KeyT") return () => addTerminal(api);
    if (key === "KeyD") return () => addTerminal(api, "right");
    if (key === "KeyJ") return () => ws.toggleTerminal();
    if (key === "Backslash") return () => ws.toggleEditor();
    if (key === "KeyW")
      return () => {
        const p = api.activePanel;
        // terminals and editor tabs close; the chat pane is the main stage
        if (p && (p.id.startsWith("terminal-") || isEditorish(p.id))) {
          p.api.close();
        }
      };
    if (key === "BracketRight") return () => cycleGroup(api, 1);
    if (key === "BracketLeft") return () => cycleGroup(api, -1);
  }
  if (cmd && shift && !alt && !ctrl) {
    if (key === "KeyF") return () => bus.openSearch("content");
    if (key === "KeyD") return () => addTerminal(api, "below");
    if (key === "BracketRight") return () => cycleTab(api, 1);
    if (key === "BracketLeft") return () => cycleTab(api, -1);
  }
  if (ctrl && !cmd && !alt) {
    if (key === "Tab") return () => cycleTab(api, shift ? -1 : 1);
    if (key === "Backquote" && !shift) return () => ws.toggleTerminal();
  }
  if (cmd && alt && !shift && !ctrl) {
    if (key === "ArrowLeft") return () => focusSplit(api, "left");
    if (key === "ArrowRight") return () => focusSplit(api, "right");
    if (key === "ArrowUp") return () => focusSplit(api, "up");
    if (key === "ArrowDown") return () => focusSplit(api, "down");
  }
  return null;
}

function App() {
  const { projects, active, loaded } = useSyncExternalStore(
    subscribeProjects,
    getProjects,
  );

  useEffect(() => {
    (async () => {
      // reap PTYs/agents/LSP/debug servers orphaned by a webview reload
      await Promise.allSettled([
        invoke("pty_reset"),
        invoke("acp_reset"),
        invoke("lsp_reset"),
        invoke("dap_reset"),
      ]);
      await initProjects();
      startGitStore();
      wireDebug();
    })();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "F5" && getDebug().paused) {
        e.preventDefault();
        continuePaused();
        return;
      }
      const action = handleKey(e);
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        action();
      }
    };
    // capture phase: beat xterm to the keystroke
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <>
      <Titlebar />
      <div className="app-body">
        {loaded &&
          projects.map((p) => (
            <Workspace key={p.root} root={p.root} visible={p.root === active} />
          ))}
      </div>
      <StatusBar />
      <SearchOverlay />
      <DebugOverlay />
    </>
  );
}

export default App;
