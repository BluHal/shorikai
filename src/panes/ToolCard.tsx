import React, { useState } from "react";
import { diffLines } from "diff";

export type ToolContentItem = {
  type: "content" | "diff" | "terminal";
  content?: { type: string; text?: string };
  path?: string;
  oldText?: string | null;
  newText?: string;
};

export type ToolRow = {
  kind: "tool";
  id: string;
  title: string;
  toolKind: string;
  status: string;
  content: ToolContentItem[];
  rawInput?: unknown;
  rawOutput?: unknown;
};

const icons: Record<string, React.ReactElement> = {
  read: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M13 2v7h7" />
    </svg>
  ),
  edit: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M4 20v-4l10-10 4 4-10 10z" />
      <path d="M13 6l4 4" />
    </svg>
  ),
  execute: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M5 8l4 4-4 4" />
      <line x1="12" y1="16" x2="19" y2="16" />
    </svg>
  ),
  search: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </svg>
  ),
};

function StatusMark({ status }: { status: string }) {
  if (status === "completed") return <span className="tool-status-ok">✓</span>;
  if (status === "failed") return <span className="tool-status-fail">✗</span>;
  return <span className="tool-spinner" />;
}

export function ToolCard({ row }: { row: ToolRow }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const diffs = row.content.filter((c) => c.type === "diff");
  const texts = row.content.filter(
    (c) => c.type === "content" && c.content?.text,
  );
  const expanded = override ?? diffs.length > 0;
  const expandable =
    row.content.length > 0 || row.rawInput != null || row.rawOutput != null;

  return (
    <div className={`tool-card${row.status === "in_progress" ? " tool-card-live" : ""}`}>
      <div
        className="tool-card-header"
        onClick={() => expandable && setOverride(!expanded)}
      >
        <span className="tool-icon">{icons[row.toolKind] ?? icons.execute}</span>
        <span className="tool-title">{row.title}</span>
        <span className="tool-card-right">
          {expandable && (
            <span className="tool-chevron">{expanded ? "▾" : "▸"}</span>
          )}
          <StatusMark status={row.status} />
        </span>
      </div>
      {expanded && (
        <div className="tool-card-body">
          {diffs.map((d, i) => (
            <DiffCard
              key={i}
              path={d.path ?? ""}
              oldText={d.oldText ?? ""}
              newText={d.newText ?? ""}
            />
          ))}
          {texts.map((t, i) => (
            <pre key={i} className="tool-output">
              {t.content!.text}
            </pre>
          ))}
          {row.rawInput != null && (
            <div className="tool-raw">
              <span className="tool-raw-label">INPUT</span>
              <pre className="tool-output">
                {JSON.stringify(row.rawInput, null, 2)}
              </pre>
            </div>
          )}
          {texts.length === 0 && row.rawOutput != null && (
            <div className="tool-raw">
              <span className="tool-raw-label">OUTPUT</span>
              <pre className="tool-output">
                {JSON.stringify(row.rawOutput, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- diff card: mini side-by-side ---------- */

type Tone = "ctx" | "del" | "add" | "empty" | "skip";
type DiffRow = { l: { text: string; tone: Tone }; r: { text: string; tone: Tone } };

function splitLines(s: string): string[] {
  const a = s.split("\n");
  if (a[a.length - 1] === "") a.pop();
  return a;
}

function buildRows(oldText: string, newText: string): DiffRow[] {
  const parts = diffLines(oldText, newText);
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (p.removed && parts[i + 1]?.added) {
      const del = splitLines(p.value);
      const add = splitLines(parts[i + 1].value);
      for (let k = 0; k < Math.max(del.length, add.length); k++) {
        rows.push({
          l: del[k] != null ? { text: del[k], tone: "del" } : { text: "", tone: "empty" },
          r: add[k] != null ? { text: add[k], tone: "add" } : { text: "", tone: "empty" },
        });
      }
      i += 2;
    } else if (p.removed) {
      for (const t of splitLines(p.value)) {
        rows.push({ l: { text: t, tone: "del" }, r: { text: "", tone: "empty" } });
      }
      i += 1;
    } else if (p.added) {
      for (const t of splitLines(p.value)) {
        rows.push({ l: { text: "", tone: "empty" }, r: { text: t, tone: "add" } });
      }
      i += 1;
    } else {
      for (const t of splitLines(p.value)) {
        rows.push({ l: { text: t, tone: "ctx" }, r: { text: t, tone: "ctx" } });
      }
      i += 1;
    }
  }
  return collapseContext(rows);
}

/* long unchanged runs fold to a "⋯ n lines" separator */
function collapseContext(rows: DiffRow[], keep = 3): DiffRow[] {
  const out: DiffRow[] = [];
  let run: DiffRow[] = [];
  const flush = () => {
    if (run.length > keep * 2 + 1) {
      out.push(...run.slice(0, keep));
      const n = run.length - keep * 2;
      out.push({
        l: { text: `⋯ ${n} unchanged lines`, tone: "skip" },
        r: { text: `⋯ ${n} unchanged lines`, tone: "skip" },
      });
      out.push(...run.slice(-keep));
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const row of rows) {
    if (row.l.tone === "ctx") run.push(row);
    else {
      flush();
      out.push(row);
    }
  }
  flush();
  return out;
}

export function DiffCard(props: { path: string; oldText: string; newText: string }) {
  const rows = buildRows(props.oldText, props.newText);
  const adds = rows.filter((r) => r.r.tone === "add").length;
  const dels = rows.filter((r) => r.l.tone === "del").length;
  const name = props.path.split("/").pop() ?? props.path;
  const ext = (name.includes(".") ? name.split(".").pop()! : "").toUpperCase();

  return (
    <div className="diff-card">
      <div className="diff-card-header">
        {ext && <span className="diff-ext">{ext}</span>}
        <span className="diff-name" title={props.path}>
          {name}
        </span>
        <span className="diff-adds">+{adds}</span>
        <span className="diff-dels">−{dels}</span>
      </div>
      <div className="diff-cols">
        <div className="diff-col diff-col-left">
          <div className="diff-col-label diff-label-del">− BEFORE</div>
          {rows.map((row, i) => (
            <div key={i} className={`diff-line diff-${row.l.tone}`}>
              {row.l.text || " "}
            </div>
          ))}
        </div>
        <div className="diff-col">
          <div className="diff-col-label diff-label-add">+ AFTER</div>
          {rows.map((row, i) => (
            <div key={i} className={`diff-line diff-${row.r.tone}`}>
              {row.r.text || " "}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
