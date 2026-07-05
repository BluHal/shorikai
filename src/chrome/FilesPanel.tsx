import { Fragment, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bus } from "../bus";

type Entry = { name: string; path: string; is_dir: boolean };

const extTags: Record<string, { label: string; className: string }> = {
  ts: { label: "TS", className: "ext-ts" },
  tsx: { label: "TS", className: "ext-ts" },
  js: { label: "JS", className: "ext-js" },
  jsx: { label: "JS", className: "ext-js" },
  json: { label: "{}", className: "ext-json" },
  md: { label: "MD", className: "ext-md" },
  rs: { label: "RS", className: "ext-rs" },
  css: { label: "#", className: "ext-css" },
  html: { label: "<>", className: "ext-html" },
};

function ExtTag({ name }: { name: string }) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const tag = extTags[ext];
  return (
    <span className={`tree-ext ${tag?.className ?? "ext-plain"}`}>
      {tag?.label ?? "·"}
    </span>
  );
}

const FolderIcon = ({ dim }: { dim?: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke={dim ? "var(--text-4)" : "var(--accent-dim)"} strokeWidth="1.7">
    <path d="M3 7l4-4h6l2 2h6v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </svg>
);

export function FilesPanel() {
  const [root, setRoot] = useState<string | null>(null);
  const [children, setChildren] = useState<Map<string, Entry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const childrenRef = useRef(children);
  childrenRef.current = children;

  const listInto = async (dir: string) => {
    try {
      const entries = await invoke<Entry[]>("ws_list", { path: dir });
      setChildren((prev) => new Map(prev).set(dir, entries));
    } catch {
      // dir vanished: drop it
      setChildren((prev) => {
        const next = new Map(prev);
        next.delete(dir);
        return next;
      });
    }
  };

  useEffect(() => {
    (async () => {
      const r = await invoke<string>("project_root");
      setRoot(r);
      await invoke("ws_watch", { root: r }).catch(() => {});
      await listInto(r);
    })();
    const un = listen<{ paths: string[] }>("ws:changed", (e) => {
      for (const p of e.payload.paths) {
        if (childrenRef.current.has(p)) listInto(p);
      }
    });
    return () => {
      un.then((u) => u());
    };
  }, []);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
        if (!childrenRef.current.has(dir)) listInto(dir);
      }
      return next;
    });
  };

  const renderDir = (dir: string, depth: number): React.ReactNode =>
    (children.get(dir) ?? []).map((e) =>
      e.is_dir ? (
        <Fragment key={e.path}>
          <div
            className="tree-row tree-dir"
            style={{ paddingLeft: 8 + depth * 18 }}
            onClick={() => toggle(e.path)}
          >
            <span className="tree-arrow">{expanded.has(e.path) ? "▾" : "▸"}</span>
            <FolderIcon />
            <span>{e.name}</span>
          </div>
          {expanded.has(e.path) && renderDir(e.path, depth + 1)}
        </Fragment>
      ) : (
        <div
          key={e.path}
          className="tree-row tree-file"
          style={{ paddingLeft: 8 + depth * 18 + 15 }}
          onClick={() => bus.openFile(e.path)}
        >
          <ExtTag name={e.name} />
          <span>{e.name}</span>
        </div>
      ),
    );

  if (!root) return <div className="sidebar-panel-empty">loading…</div>;
  return <div className="tree">{renderDir(root, 0)}</div>;
}
