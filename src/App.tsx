import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  IDockviewHeaderActionsProps,
} from "dockview-react";
import { Titlebar } from "./chrome/Titlebar";
import { Sidebar } from "./chrome/Sidebar";
import { StatusBar } from "./chrome/StatusBar";
import { SearchOverlay } from "./chrome/SearchOverlay";
import { TerminalPane } from "./panes/TerminalPane";
import { ChatPane } from "./panes/ChatPane";
import { EditorPane } from "./panes/EditorPane";
import { DiffPane } from "./panes/DiffPane";
import { bus } from "./bus";
import { startGitStore } from "./gitStore";
import "dockview-react/dist/styles/dockview.css";
import "./App.css";

const components = {
  terminal: TerminalPane,
  chat: ChatPane,
  editor: EditorPane,
  diff: DiffPane,
};

const isEditorish = (id: string) =>
  id.startsWith("editor:") || id.startsWith("diff:");

const isTerminalId = (id: string) => id.startsWith("terminal-");

// tab-bar chips: "⌘\ dock" on editor groups, "⌄" toggle on terminal groups
function DockChip(props: IDockviewHeaderActionsProps) {
  if (props.panels.some((p) => isEditorish(p.id))) {
    return (
      <div className="dock-chip" onClick={() => bus.collapseEditor()} title="Collapse editor  ⌘\">
        <span className="dock-chip-key">⌘\</span> dock
      </div>
    );
  }
  if (props.panels.length > 0 && props.panels.every((p) => isTerminalId(p.id))) {
    return (
      <div className="dock-chip" onClick={() => bus.toggleTerminal()} title="Toggle terminal panel  ⌘J">
        ⌄
      </div>
    );
  }
  return null;
}

type RailFile = {
  id: string;
  component: string;
  title: string;
  params: Record<string, unknown>;
  active: boolean;
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
    if (key === "KeyP") return () => bus.openSearch("files");
    if (key === "KeyT") return () => addTerminal(api);
    if (key === "KeyD") return () => addTerminal(api, "right");
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

function EditorRail(props: {
  files: RailFile[];
  onRestore: (activateId?: string) => void;
}) {
  return (
    <div
      className="editor-rail"
      title="Expand editor  ⌘\"
      onClick={() => props.onRestore()}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7">
        <line x1="20" y1="5" x2="20" y2="19" />
        <path d="M4 6l6 6-6 6" />
      </svg>
      <div className="rail-label">Editor</div>
      <div className="rail-files">
        {props.files.map((f) => (
          <div
            key={f.id}
            className="rail-file"
            onClick={(e) => {
              e.stopPropagation();
              props.onRestore(f.id);
            }}
          >
            <span
              className={`rail-dot ${f.title.startsWith("●") ? "rail-dot-dirty" : ""}`}
            />
            <div className="rail-file-name">{f.title.replace(/^● /, "")}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  const apiRef = useRef<DockviewApi | null>(null);
  const [rail, setRail] = useState<RailFile[] | null>(null);
  const railRef = useRef(rail);
  railRef.current = rail;

  const restoreEditors = (activateId?: string) => {
    const api = apiRef.current;
    const files = railRef.current;
    if (!api || !files) return;
    setRail(null);
    const chat = api.getPanel("chat");
    let first: string | undefined;
    for (const f of files) {
      api.addPanel({
        id: f.id,
        component: f.component,
        title: f.title,
        params: f.params,
        position: first
          ? { referencePanel: first, direction: "within" }
          : chat
            ? { referencePanel: chat, direction: "right" }
            : undefined,
      });
      first = first ?? f.id;
    }
    const target = activateId ?? files.find((f) => f.active)?.id ?? first;
    if (target) api.getPanel(target)?.api.setActive();
  };

  // terminal groups shrink to their 30px tab bar instead of closing: the
  // PTYs (and anything running in them) stay alive
  const termHeights = useRef(new Map<string, number>());
  const toggleTerminal = () => {
    const api = apiRef.current;
    if (!api) return;
    const groups = api.groups.filter(
      (g) => g.panels.length > 0 && g.panels.every((p) => isTerminalId(p.id)),
    );
    if (groups.length === 0) return;
    const collapsed = groups.every((g) => g.height <= 40);
    for (const g of groups) {
      if (collapsed) {
        g.api.setSize({ height: termHeights.current.get(g.id) ?? 240 });
      } else {
        termHeights.current.set(g.id, g.height);
        g.api.setConstraints({ minimumHeight: 30 });
        g.api.setSize({ height: 30 });
      }
    }
  };

  const collapseEditors = () => {
    const api = apiRef.current;
    if (!api || railRef.current) return;
    const editors = api.panels.filter((p) => isEditorish(p.id));
    if (editors.length === 0) return;
    const files: RailFile[] = editors.map((p) => ({
      id: p.id,
      component: p.id.startsWith("diff:") ? "diff" : "editor",
      title: p.title ?? p.id,
      params: (p.params ?? {}) as Record<string, unknown>,
      active: api.activePanel === p,
    }));
    // chat recenters automatically: it keeps its 760px reading measure
    for (const p of editors) api.removePanel(p);
    setRail(files);
  };

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    const spawnTerminalBelowChat = () => {
      const chat = event.api.getPanel("chat");
      const panel = event.api.addPanel({
        id: `terminal-${++termSeq}`,
        component: "terminal",
        title: "zsh",
        position: chat
          ? { referencePanel: chat, direction: "below" }
          : undefined,
      });
      return panel;
    };
    bus.collapseEditor = collapseEditors;
    bus.toggleTerminal = toggleTerminal;
    bus.openFile = (path, line) => {
      restoreEditors();
      const id = `editor:${path}`;
      const existing = event.api.getPanel(id);
      if (existing) {
        if (line != null) {
          existing.api.updateParameters({ path, line, nonce: Date.now() });
        }
        existing.api.setActive();
        return;
      }
      const chat = event.api.getPanel("chat");
      const anyEditor = event.api.panels.find((p) => isEditorish(p.id));
      event.api.addPanel({
        id,
        component: "editor",
        title: path.split("/").pop() ?? path,
        params: { path, line },
        position: anyEditor
          ? { referencePanel: anyEditor, direction: "within" }
          : chat
            ? { referencePanel: chat, direction: "right" }
            : undefined,
      });
    };
    bus.openDiff = (path, oldText, newText) => {
      restoreEditors();
      const id = `diff:${path}`;
      event.api.getPanel(id)?.api.close();
      const chat = event.api.getPanel("chat");
      const anyEditor = event.api.panels.find((p) => isEditorish(p.id));
      event.api.addPanel({
        id,
        component: "diff",
        title: `Δ ${path.split("/").pop() ?? path}`,
        params: { path, oldText, newText },
        position: anyEditor
          ? { referencePanel: anyEditor, direction: "within" }
          : chat
            ? { referencePanel: chat, direction: "right" }
            : undefined,
      });
    };
    // reap PTYs/agents orphaned by a webview reload before spawning ours
    Promise.allSettled([invoke("pty_reset"), invoke("acp_reset")]).finally(
      () => {
        event.api.addPanel({
          id: "chat",
          component: "chat",
          title: "Claude Code",
        });
        spawnTerminalBelowChat().api.setSize({ height: 240 });
      },
    );
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const api = apiRef.current;
      if (!api) return;
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === "Backslash") {
        e.preventDefault();
        e.stopPropagation();
        if (railRef.current) restoreEditors();
        else collapseEditors();
        return;
      }
      const cmdJ =
        e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === "KeyJ";
      const ctrlBacktick =
        e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.code === "Backquote";
      if (cmdJ || ctrlBacktick) {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminal();
        return;
      }
      const action = handleKey(api, e);
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        action();
      }
    };
    // capture phase: beat xterm to the keystroke
    window.addEventListener("keydown", onKeyDown, true);
    startGitStore();
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
          rightHeaderActionsComponent={DockChip}
          onReady={onReady}
        />
        {rail && <EditorRail files={rail} onRestore={restoreEditors} />}
      </div>
      <StatusBar />
      <SearchOverlay />
    </>
  );
}

export default App;
