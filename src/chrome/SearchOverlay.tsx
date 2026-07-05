import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bus } from "../bus";
import { getProjects } from "../projects";

type Mode = "files" | "content";
type ContentHit = { path: string; line: number; text: string; spans: [number, number][] };

function Highlighted({ text, spans }: { text: string; spans: [number, number][] }) {
  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const [start, end] of spans) {
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(
      <span key={start} className="search-match">
        {text.slice(start, end)}
      </span>,
    );
    pos = end;
  }
  parts.push(text.slice(pos));
  return <>{parts}</>;
}

export function SearchOverlay() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [query, setQuery] = useState("");
  const [fileHits, setFileHits] = useState<string[]>([]);
  const [contentHits, setContentHits] = useState<ContentHit[]>([]);
  const [sel, setSel] = useState(0);
  const rootRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bus.openSearch = (m) => {
      setMode(m);
      setSel(0);
      setTimeout(() => inputRef.current?.select(), 0);
    };
    return () => {
      bus.openSearch = () => {};
    };
  }, []);

  useEffect(() => {
    if (!mode) return;
    const seq = ++seqRef.current;
    const run = async () => {
      rootRef.current = getProjects().active;
      const root = rootRef.current;
      if (!root) return;
      try {
        if (mode === "files") {
          const hits = await invoke<string[]>("ws_fuzzy", { root, query });
          if (seq === seqRef.current) {
            setFileHits(hits);
            setSel(0);
          }
        } else {
          if (query.trim().length < 2) {
            setContentHits([]);
            return;
          }
          const hits = await invoke<ContentHit[]>("ws_search", { root, query });
          if (seq === seqRef.current) {
            setContentHits(hits);
            setSel(0);
          }
        }
      } catch (err) {
        if (seq === seqRef.current && mode === "content") {
          setContentHits([{ path: String(err), line: 0, text: "", spans: [] }]);
        }
      }
    };
    const t = setTimeout(run, mode === "files" ? 60 : 180);
    return () => clearTimeout(t);
  }, [query, mode]);

  if (!mode) return null;

  const count = mode === "files" ? fileHits.length : contentHits.length;

  const openSel = () => {
    const root = rootRef.current;
    if (!root) return;
    if (mode === "files") {
      const hit = fileHits[sel];
      if (hit) bus.openFile(`${root}/${hit}`);
    } else {
      const hit = contentHits[sel];
      if (hit && hit.line > 0) bus.openFile(`${root}/${hit.path}`, hit.line);
    }
    setMode(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setMode(null);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, count - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openSel();
    }
  };

  return (
    <div className="search-backdrop" onMouseDown={() => setMode(null)}>
      <div className="search-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-head">
          <div className="search-modes">
            <button
              className={mode === "files" ? "search-mode-active" : ""}
              onClick={() => setMode("files")}
            >
              Files
            </button>
            <button
              className={mode === "content" ? "search-mode-active" : ""}
              onClick={() => setMode("content")}
            >
              Content
            </button>
          </div>
          <input
            ref={inputRef}
            autoFocus
            className="search-input"
            placeholder={mode === "files" ? "fuzzy file name…" : "search project content…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="search-results">
          {mode === "files"
            ? fileHits.map((f, i) => {
                const cut = f.lastIndexOf("/");
                return (
                  <div
                    key={f}
                    className={`search-row${i === sel ? " search-row-sel" : ""}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={openSel}
                  >
                    <span className="search-name">{f.slice(cut + 1)}</span>
                    {cut > 0 && <span className="search-dir">{f.slice(0, cut)}</span>}
                  </div>
                );
              })
            : contentHits.map((h, i) => (
                <div
                  key={`${h.path}:${h.line}:${i}`}
                  className={`search-row${i === sel ? " search-row-sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={openSel}
                >
                  <span className="search-name">
                    {h.path}
                    {h.line > 0 && <span className="search-line">:{h.line}</span>}
                  </span>
                  <span className="search-preview">
                    <Highlighted text={h.text} spans={h.spans} />
                  </span>
                </div>
              ))}
          {count === 0 && query && (
            <div className="search-empty">no matches</div>
          )}
        </div>
      </div>
    </div>
  );
}
