import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  continuePaused,
  evaluateExpression,
  fetchScopes,
  fetchVariables,
  Frame,
  getDebug,
  pauseRunning,
  Scope,
  selectFrame,
  step,
  subscribeDebug,
  Variable,
} from "../debug";

function VarNode({ v, depth }: { v: Variable; depth: number }) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<Variable[] | null>(null);
  const expandable = v.variablesReference > 0;

  const toggle = async () => {
    if (!expandable) return;
    if (!open && kids == null) {
      setKids(await fetchVariables(v.variablesReference));
    }
    setOpen(!open);
  };

  return (
    <>
      <div
        className="dbg-var"
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={toggle}
      >
        <span className="dbg-var-arrow">{expandable ? (open ? "▾" : "▸") : ""}</span>
        <span className="dbg-var-name">{v.name}</span>
        <span className="dbg-var-value" title={v.value}>
          {v.value}
        </span>
      </div>
      {open && kids?.map((k, i) => <VarNode key={`${k.name}:${i}`} v={k} depth={depth + 1} />)}
    </>
  );
}

function ScopeNode({ scope, nonce }: { scope: Scope; nonce: number }) {
  const [open, setOpen] = useState(!scope.expensive);
  const [vars, setVars] = useState<Variable[] | null>(null);

  useEffect(() => {
    setVars(null);
    if (open) fetchVariables(scope.variablesReference).then(setVars);
    // refetch on every stop and scope identity change
  }, [scope.variablesReference, nonce, open]);

  return (
    <>
      <div className="dbg-scope" onClick={() => setOpen(!open)}>
        <span className="dbg-var-arrow">{open ? "▾" : "▸"}</span>
        {scope.name}
      </div>
      {open && vars?.map((v, i) => <VarNode key={`${v.name}:${i}`} v={v} depth={1} />)}
    </>
  );
}

export function DebugPane() {
  const dbg = useSyncExternalStore(subscribeDebug, getDebug);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [input, setInput] = useState("");
  const consoleRef = useRef<HTMLDivElement>(null);

  const paused = dbg.paused != null;

  useEffect(() => {
    if (dbg.selectedFrame != null) {
      fetchScopes(dbg.selectedFrame).then(setScopes);
    } else {
      setScopes([]);
    }
  }, [dbg.selectedFrame, dbg.stopNonce]);

  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [dbg.consoleLines]);

  const frameRow = (f: Frame) => (
    <div
      key={f.id}
      className={`dbg-frame${f.id === dbg.selectedFrame ? " dbg-frame-sel" : ""}`}
      onClick={() => selectFrame(f.id)}
    >
      <span className="dbg-frame-name">{f.name}</span>
      {f.path && (
        <span className="dbg-frame-loc">
          {f.path.split("/").pop()}
          {f.line != null ? `:${f.line}` : ""}
        </span>
      )}
    </div>
  );

  return (
    <div className="dbg-pane">
      <div className="dbg-toolbar">
        {paused ? (
          <button title="Continue  F5" onClick={continuePaused}>
            ▶
          </button>
        ) : (
          <button title="Pause  F6" onClick={pauseRunning}>
            ⏸
          </button>
        )}
        <button title="Step over  F10" disabled={!paused} onClick={() => step("next")}>
          ⤵
        </button>
        <button title="Step into  F11" disabled={!paused} onClick={() => step("stepIn")}>
          ↓
        </button>
        <button title="Step out  ⇧F11" disabled={!paused} onClick={() => step("stepOut")}>
          ↑
        </button>
        <span className="dbg-state">
          {paused
            ? `paused${dbg.paused?.path ? ` · ${dbg.paused.path.split("/").pop()}:${dbg.paused.line}` : ""}`
            : "running"}
        </span>
      </div>

      <div className="dbg-body">
        <div className="dbg-col dbg-stack">
          <div className="dbg-col-title">CALL STACK</div>
          {dbg.frames.map(frameRow)}
          {paused && dbg.frames.length === 0 && (
            <div className="dbg-empty">loading…</div>
          )}
          {!paused && <div className="dbg-empty">not paused</div>}
        </div>
        <div className="dbg-col dbg-vars">
          <div className="dbg-col-title">VARIABLES</div>
          {paused ? (
            scopes.map((s) => (
              <ScopeNode
                key={`${s.name}:${s.variablesReference}`}
                scope={s}
                nonce={dbg.stopNonce}
              />
            ))
          ) : (
            <div className="dbg-empty">—</div>
          )}
        </div>
      </div>

      <div className="dbg-console">
        <div className="dbg-console-lines" ref={consoleRef}>
          {dbg.consoleLines.map((l, i) => (
            <div key={i} className={`dbg-line dbg-line-${l.kind}`}>
              {l.kind === "input" ? `› ${l.text}` : l.text}
            </div>
          ))}
        </div>
        <input
          className="dbg-console-input"
          placeholder={paused ? "evaluate in paused frame…" : "debug console"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              evaluateExpression(input.trim());
              setInput("");
            }
          }}
        />
      </div>
    </div>
  );
}
