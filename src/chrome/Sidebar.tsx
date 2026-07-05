import { useState } from "react";
import { FilesPanel } from "./FilesPanel";
import { bus } from "../bus";

const FileIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M13 2v7h7" />
  </svg>
);
const SearchIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.5" y2="16.5" />
  </svg>
);
const GitIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="8" r="2.4" />
    <path d="M6 8.4v7.2M8.4 6H14a3 3 0 0 1 3 3" />
  </svg>
);

const views = [
  { id: "files", label: "Files", icon: FileIcon },
  { id: "search", label: "Search", icon: SearchIcon },
  { id: "git", label: "Git", icon: GitIcon },
] as const;

type ViewId = (typeof views)[number]["id"];

export function Sidebar() {
  const [view, setView] = useState<ViewId>("files");

  return (
    <div className="sidebar">
      <div className="sidebar-wordmark">
        <span className="wordmark-glyph">
          <span />
        </span>
        <span className="wordmark-name">SHORIKAI</span>
        <span className="wordmark-version">v0.1.0</span>
      </div>

      <div className="sidebar-switch-wrap">
        <div className="sidebar-switch">
          {views.map((v) => (
            <button
              key={v.id}
              className={`switch-item${view === v.id ? " switch-item-active" : ""}`}
              onClick={() => setView(v.id)}
            >
              {v.icon}
              <span>{v.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-panel-header">
        {view === "files" && <span>EXPLORER</span>}
        {view === "search" && <span>SEARCH</span>}
        {view === "git" && <span>SOURCE CONTROL</span>}
      </div>

      {/* git (#11) panel comes in a later slice */}
      {view === "files" ? (
        <FilesPanel />
      ) : view === "search" ? (
        <div className="sidebar-panel-empty sidebar-search-hint">
          <button onClick={() => bus.openSearch("files")}>⌘P — files</button>
          <button onClick={() => bus.openSearch("content")}>⌘⇧F — content</button>
        </div>
      ) : (
        <div className="sidebar-panel-empty">git panel comes soon</div>
      )}
    </div>
  );
}
