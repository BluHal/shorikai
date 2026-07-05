import { useEffect, useRef, useState } from "react";
import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  IDockviewHeaderActionsProps,
  SerializedDockview,
} from "dockview-react";
import { Sidebar } from "./chrome/Sidebar";
import { TerminalPane } from "./panes/TerminalPane";
import { ChatPane } from "./panes/ChatPane";
import { EditorPane } from "./panes/EditorPane";
import { DiffPane } from "./panes/DiffPane";
import { bus } from "./bus";
import {
  ProjectCtx,
  registerWorkspace,
  saveSession,
  takeSavedLayout,
  unregisterWorkspace,
} from "./projects";

const components = {
  terminal: TerminalPane,
  chat: ChatPane,
  editor: EditorPane,
  diff: DiffPane,
};

export const isEditorish = (id: string) =>
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
      <div className="dock-chip-row">
        <div
          className="dock-chip dock-chip-debug"
          onClick={() => bus.startDebugTerminal()}
          title="New debug terminal — any node process auto-attaches"
        >
          ⚡ debug
        </div>
        <div className="dock-chip" onClick={() => bus.toggleTerminal()} title="Toggle terminal panel  ⌘J">
          ⌄
        </div>
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

export function addTerminal(api: DockviewApi, direction?: "right" | "below") {
  const group = api.activeGroup;
  api.addPanel({
    id: `terminal-${++termSeq}`,
    component: "terminal",
    title: "zsh",
    position:
      direction && group ? { referenceGroup: group, direction } : undefined,
  });
}

function EditorRail(props: {
  files: RailFile[];
  onRestore: (activateId?: string) => void;
}) {
  return (
    <div className="editor-rail" title="Expand editor  ⌘\" onClick={() => props.onRestore()}>
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
            <span className={`rail-dot ${f.title.startsWith("●") ? "rail-dot-dirty" : ""}`} />
            <div className="rail-file-name">{f.title.replace(/^● /, "")}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Workspace(props: { root: string; visible: boolean }) {
  const { root } = props;
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
    for (const p of editors) api.removePanel(p);
    setRail(files);
  };

  const toggleEditor = () => {
    if (railRef.current) restoreEditors();
    else collapseEditors();
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

  const openFile = (path: string, line?: number) => {
    const api = apiRef.current;
    if (!api) return;
    restoreEditors();
    const id = `editor:${path}`;
    const existing = api.getPanel(id);
    if (existing) {
      if (line != null) {
        existing.api.updateParameters({ path, line, nonce: Date.now() });
      }
      existing.api.setActive();
      return;
    }
    const chat = api.getPanel("chat");
    const anyEditor = api.panels.find((p) => isEditorish(p.id));
    api.addPanel({
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

  const openDiff = (path: string, oldText: string, newText: string) => {
    const api = apiRef.current;
    if (!api) return;
    restoreEditors();
    const id = `diff:${path}`;
    api.getPanel(id)?.api.close();
    const chat = api.getPanel("chat");
    const anyEditor = api.panels.find((p) => isEditorish(p.id));
    api.addPanel({
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

  const addDebugTerminal = (opts: {
    env: Record<string, string>;
    title: string;
    dapReply: { sessionId: number; requestSeq: number };
  }) => {
    const api = apiRef.current;
    if (!api) return;
    const termGroup = api.groups.find(
      (g) => g.panels.length > 0 && g.panels.every((p) => isTerminalId(p.id)),
    );
    const chat = api.getPanel("chat");
    api.addPanel({
      id: `terminal-${++termSeq}`,
      component: "terminal",
      title: opts.title,
      params: { env: opts.env, dapReply: opts.dapReply },
      position: termGroup
        ? { referenceGroup: termGroup, direction: "within" }
        : chat
          ? { referencePanel: chat, direction: "below" }
          : undefined,
    });
    // a collapsed terminal strip pops open to show the new debug terminal
    if (termGroup && termGroup.height <= 40) {
      termGroup.api.setSize({ height: termHeights.current.get(termGroup.id) ?? 240 });
    }
  };

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    registerWorkspace(root, {
      api: event.api,
      openFile,
      openDiff,
      collapseEditor: collapseEditors,
      toggleEditor,
      toggleTerminal,
      addDebugTerminal,
    });

    let restored = false;
    const saved = takeSavedLayout(root);
    if (saved) {
      try {
        event.api.fromJSON(saved as SerializedDockview);
        restored = event.api.panels.length > 0;
        // keep terminal ids from colliding with restored ones
        for (const p of event.api.panels) {
          const m = /^terminal-(\d+)$/.exec(p.id);
          if (m) termSeq = Math.max(termSeq, Number(m[1]));
        }
      } catch {
        restored = false;
      }
    }
    if (!restored || !event.api.getPanel("chat")) {
      if (!event.api.getPanel("chat")) {
        event.api.addPanel({ id: "chat", component: "chat", title: "Claude Code" });
      }
      if (!event.api.panels.some((p) => isTerminalId(p.id))) {
        const chat = event.api.getPanel("chat");
        const panel = event.api.addPanel({
          id: `terminal-${++termSeq}`,
          component: "terminal",
          title: "zsh",
          position: chat
            ? { referencePanel: chat, direction: "below" }
            : undefined,
        });
        panel.api.setSize({ height: 240 });
      }
    }
    event.api.onDidLayoutChange(() => saveSession());
  };

  useEffect(() => () => unregisterWorkspace(root), [root]);

  return (
    <ProjectCtx.Provider value={root}>
      <div className="workspace" style={{ display: props.visible ? "flex" : "none" }}>
        <Sidebar />
        <DockviewReact
          className="dockview-theme-dark app-dock"
          components={components}
          rightHeaderActionsComponent={DockChip}
          onReady={onReady}
        />
        {rail && <EditorRail files={rail} onRestore={restoreEditors} />}
      </div>
    </ProjectCtx.Provider>
  );
}
