import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
} from "dockview-react";
import { Titlebar } from "./chrome/Titlebar";
import { Sidebar } from "./chrome/Sidebar";
import { StatusBar } from "./chrome/StatusBar";
import { TerminalPane } from "./panes/TerminalPane";
import "dockview-react/dist/styles/dockview.css";
import "./App.css";

const components = {
  terminal: TerminalPane,
};

let termSeq = 0;

function addTerminal(api: DockviewApi, direction?: "right" | "below") {
  const group = api.activeGroup;
  api.addPanel({
    id: `terminal-${++termSeq}`,
    component: "terminal",
    title: "zsh",
    position:
      direction && group ? { referenceGroup: group, direction } : undefined,
  });
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
function handleKey(api: DockviewApi, e: KeyboardEvent): (() => void) | null {
  const { metaKey: cmd, shiftKey: shift, altKey: alt, ctrlKey: ctrl } = e;
  const key = e.code;

  if (cmd && !shift && !alt && !ctrl) {
    if (key === "KeyT") return () => addTerminal(api);
    if (key === "KeyD") return () => addTerminal(api, "right");
    if (key === "KeyW") return () => api.activePanel?.api.close();
    if (key === "BracketRight") return () => cycleGroup(api, 1);
    if (key === "BracketLeft") return () => cycleGroup(api, -1);
  }
  if (cmd && shift && !alt && !ctrl) {
    if (key === "KeyD") return () => addTerminal(api, "below");
    if (key === "BracketRight") return () => cycleTab(api, 1);
    if (key === "BracketLeft") return () => cycleTab(api, -1);
  }
  if (ctrl && !cmd && !alt && key === "Tab") {
    return () => cycleTab(api, shift ? -1 : 1);
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
  const apiRef = useRef<DockviewApi | null>(null);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    // the cockpit always keeps at least one terminal alive
    event.api.onDidRemovePanel(() => {
      if (event.api.panels.length === 0) addTerminal(event.api);
    });
    // reap PTYs orphaned by a webview reload before spawning ours
    invoke("pty_reset")
      .catch(() => {})
      .finally(() => addTerminal(event.api));
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const api = apiRef.current;
      if (!api) return;
      const action = handleKey(api, e);
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
        <Sidebar />
        <DockviewReact
          className="dockview-theme-dark app-dock"
          components={components}
          onReady={onReady}
        />
      </div>
      <StatusBar />
    </>
  );
}

export default App;
