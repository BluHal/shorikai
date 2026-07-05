import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolCard, ToolContentItem, ToolRow } from "./ToolCard";
import { mdComponentsFor } from "./mdComponents";
import { setAgentStatus, useProjectRoot } from "../projects";
import {
  AgentStrip,
  DrillBody,
  DrillCrumb,
  SubAgent,
  TeamCard,
} from "./SubAgents";

type PermissionOption = { optionId: string; name: string; kind?: string };

type Row =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string; done: boolean }
  | { kind: "system"; text: string; restart?: boolean }
  | { kind: "team"; ids: string[] }
  | ToolRow
  | {
      kind: "permission";
      requestId: unknown;
      title: string;
      options: PermissionOption[];
      decided?: string;
    };

type ToolUpdate = {
  sessionUpdate?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: ToolContentItem[];
  rawInput?: unknown;
  rawOutput?: unknown;
};

function applyToolUpdate(rows: Row[], u: ToolUpdate): Row[] {
  const existing = rows.some(
    (r) => r.kind === "tool" && r.id === u.toolCallId,
  );
  if (u.sessionUpdate === "tool_call" && !existing) {
    return [
      ...rows,
      {
        kind: "tool",
        id: u.toolCallId ?? "",
        title: u.title ?? u.toolCallId ?? "tool call",
        toolKind: u.kind ?? "other",
        status: u.status ?? "pending",
        content: u.content ?? [],
        rawInput: u.rawInput,
        rawOutput: u.rawOutput,
      },
    ];
  }
  return rows.map((r) =>
    r.kind === "tool" && r.id === u.toolCallId
      ? {
          ...r,
          title: u.title ?? r.title,
          toolKind: u.kind ?? r.toolKind,
          status: u.status ?? r.status,
          content: u.content ?? r.content,
          rawInput: u.rawInput ?? r.rawInput,
          rawOutput: u.rawOutput ?? r.rawOutput,
        }
      : r,
  );
}

type AcpEvent = {
  kind:
    | "session_ready"
    | "agent_text"
    | "agent_thought"
    | "tool_call"
    | "plan"
    | "sub_agent_update"
    | "permission_request"
    | "turn_ended"
    | "agent_exit"
    | "error";
  agent_id: number;
  text?: string;
  update?: ToolUpdate;
  sub?: SubAgent;
  request_id?: unknown;
  request?: {
    toolCall?: { title?: string };
    options?: PermissionOption[];
  };
  stop_reason?: string;
  code?: number | null;
  message?: string;
};

type Status = "starting" | "ready" | "busy" | "dead";

const AGENT = "claude-code";

export function ChatPane() {
  const root = useProjectRoot();
  const mdComponents = mdComponentsFor(root);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<Status>("starting");
  const [input, setInput] = useState("");
  const [subs, setSubs] = useState<SubAgent[]>([]);
  const [drill, setDrill] = useState<string | null>(null);
  const agentIdRef = useRef<number | null>(null);
  const subsRef = useRef<SubAgent[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const start = async () => {
    setStatus("starting");
    subsRef.current = [];
    setSubs([]);
    setDrill(null);
    try {
      agentIdRef.current = await invoke<number>("acp_start", {
        agent: AGENT,
        cwd: root,
      });
    } catch (err) {
      setStatus("dead");
      setRows((r) => [
        ...r,
        { kind: "system", text: `failed to start agent: ${err}`, restart: true },
      ]);
    }
  };

  useEffect(() => {
    const unlisten = listen<AcpEvent>("acp:event", (e) => {
      const ev = e.payload;
      if (ev.agent_id !== agentIdRef.current) return;
      switch (ev.kind) {
        case "session_ready":
          setStatus("ready");
          break;
        case "agent_text":
          setRows((r) => {
            const last = r[r.length - 1];
            if (last?.kind === "agent" && !last.done) {
              return [
                ...r.slice(0, -1),
                { ...last, text: last.text + (ev.text ?? "") },
              ];
            }
            return [...r, { kind: "agent", text: ev.text ?? "", done: false }];
          });
          break;
        case "tool_call":
          if (ev.update) {
            const u = ev.update;
            setRows((r) => applyToolUpdate(r, u));
          }
          break;
        case "sub_agent_update": {
          const sub = ev.sub;
          if (!sub) break;
          const isNew = !subsRef.current.some((s) => s.id === sub.id);
          subsRef.current = isNew
            ? [...subsRef.current, sub]
            : subsRef.current.map((s) => (s.id === sub.id ? sub : s));
          setSubs(subsRef.current);
          if (isNew) {
            // consecutive spawns merge into one team card
            setRows((r) => {
              const last = r[r.length - 1];
              if (last?.kind === "team") {
                return [...r.slice(0, -1), { ...last, ids: [...last.ids, sub.id] }];
              }
              return [...r, { kind: "team", ids: [sub.id] }];
            });
          }
          break;
        }
        case "permission_request":
          setAgentStatus(root, "attention");
          setRows((r) => [
            ...r,
            {
              kind: "permission",
              requestId: ev.request_id,
              title: ev.request?.toolCall?.title ?? "The agent needs permission",
              options: ev.request?.options ?? [],
            },
          ]);
          break;
        case "turn_ended":
          setRows((r) =>
            r.map((row) =>
              row.kind === "agent" && !row.done ? { ...row, done: true } : row,
            ),
          );
          setStatus("ready");
          setAgentStatus(root, "attention"); // downgraded to idle if tab is active
          break;
        case "agent_exit":
          setStatus("dead");
          setAgentStatus(root, "attention");
          setRows((r) => [
            ...r,
            {
              kind: "system",
              text: `agent exited${ev.code != null ? ` (code ${ev.code})` : ""}`,
              restart: true,
            },
          ]);
          break;
        case "error":
          setRows((r) => [
            ...r,
            { kind: "system", text: `error: ${ev.message}` },
          ]);
          setStatus((s) => (s === "starting" ? "dead" : s));
          break;
      }
    });
    start();
    return () => {
      unlisten.then((u) => u());
      const id = agentIdRef.current;
      if (id != null) invoke("acp_kill", { id }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows]);

  const send = () => {
    const text = input.trim();
    if (!text || status !== "ready") return;
    setRows((r) => [...r, { kind: "user", text }]);
    setInput("");
    setStatus("busy");
    setAgentStatus(root, "working");
    invoke("acp_prompt", { id: agentIdRef.current, text }).catch((err) => {
      setStatus("ready");
      setAgentStatus(root, "idle");
      setRows((r) => [...r, { kind: "system", text: `error: ${err}` }]);
    });
  };

  const decide = (row: Row & { kind: "permission" }, optionId: string) => {
    invoke("acp_permission_response", {
      id: agentIdRef.current,
      requestId: row.requestId,
      optionId,
    }).catch(() => {});
    setRows((r) =>
      r.map((x) =>
        x === row ? { ...x, decided: optionId } : x,
      ),
    );
  };

  const statusText: Record<Status, string> = {
    starting: "starting…",
    ready: "ready",
    busy: "working…",
    dead: "not running",
  };

  const drilledSub = drill ? subs.find((s) => s.id === drill) : undefined;

  return (
    <div className="chat-pane">
      <div className="chat-header">
        <span className="chat-avatar">&gt;_</span>
        <div className="chat-title">
          <span className="chat-name">Claude Code</span>
          <span className="chat-status">
            <span className={`chat-dot chat-dot-${status}`} />
            {statusText[status]}
          </span>
        </div>
      </div>

      {drilledSub ? (
        <DrillCrumb sub={drilledSub} onBack={() => setDrill(null)} />
      ) : (
        subs.length > 0 && <AgentStrip subs={subs} onDrill={setDrill} />
      )}

      {drilledSub ? (
        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-rows">
            <DrillBody sub={drilledSub} />
          </div>
        </div>
      ) : (
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-rows">
          {rows.map((row, i) => {
            switch (row.kind) {
              case "user":
                return (
                  <div key={i} className="chat-user">
                    <span className="chat-user-label">you</span>
                    <div className="chat-user-bubble">{row.text}</div>
                  </div>
                );
              case "agent":
                return (
                  <div key={i} className="chat-agent chat-md">
                    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                      {row.text}
                    </Markdown>
                  </div>
                );
              case "system":
                return (
                  <div key={i} className="chat-system">
                    <span>{row.text}</span>
                    {row.restart && (
                      <button className="chat-restart" onClick={start}>
                        restart
                      </button>
                    )}
                  </div>
                );
              case "tool":
                return <ToolCard key={row.id} row={row} />;
              case "team":
                return (
                  <TeamCard
                    key={i}
                    ids={row.ids}
                    subs={subs}
                    onDrill={setDrill}
                  />
                );
              case "permission":
                return (
                  <div key={i} className="chat-permission">
                    <div className="chat-permission-title">{row.title}</div>
                    <div className="chat-permission-options">
                      {row.options.map((o) => (
                        <button
                          key={o.optionId}
                          disabled={row.decided != null}
                          className={[
                            o.kind?.startsWith("reject") ? "chat-permission-reject" : "",
                            row.decided === o.optionId ? "chat-permission-chosen" : "",
                          ].join(" ")}
                          onClick={() => decide(row, o.optionId)}
                        >
                          {o.name}
                        </button>
                      ))}
                    </div>
                  </div>
                );
            }
          })}
          {status === "busy" && <div className="chat-working" />}
        </div>
      </div>
      )}

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          rows={2}
          value={input}
          placeholder={
            status === "ready"
              ? "message claude code — enter to send"
              : statusText[status]
          }
          disabled={status === "dead"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape" && status === "busy") {
              invoke("acp_cancel", { id: agentIdRef.current }).catch(() => {});
            }
          }}
        />
      </div>
    </div>
  );
}
