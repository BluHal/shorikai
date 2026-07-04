import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

type PermissionOption = { optionId: string; name: string; kind?: string };

type Row =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string; done: boolean }
  | { kind: "system"; text: string; restart?: boolean }
  | {
      kind: "permission";
      requestId: unknown;
      title: string;
      options: PermissionOption[];
      decided?: string;
    };

type AcpEvent = {
  kind:
    | "session_ready"
    | "agent_text"
    | "agent_thought"
    | "tool_call"
    | "plan"
    | "permission_request"
    | "turn_ended"
    | "agent_exit"
    | "error";
  agent_id: number;
  text?: string;
  update?: { title?: string; sessionUpdate?: string };
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
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<Status>("starting");
  const [activity, setActivity] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const agentIdRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const start = async () => {
    setStatus("starting");
    try {
      const root = await invoke<string>("project_root");
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
          if (ev.update?.title) setActivity(ev.update.title);
          break;
        case "permission_request":
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
            r.map((row, i) =>
              i === r.length - 1 && row.kind === "agent"
                ? { ...row, done: true }
                : row,
            ),
          );
          setActivity(null);
          setStatus("ready");
          break;
        case "agent_exit":
          setStatus("dead");
          setActivity(null);
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
  }, [rows, activity]);

  const send = () => {
    const text = input.trim();
    if (!text || status !== "ready") return;
    setRows((r) => [...r, { kind: "user", text }]);
    setInput("");
    setStatus("busy");
    invoke("acp_prompt", { id: agentIdRef.current, text }).catch((err) => {
      setStatus("ready");
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
                    <Markdown remarkPlugins={[remarkGfm]}>{row.text}</Markdown>
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
              case "permission":
                return (
                  <div key={i} className="chat-permission">
                    <div className="chat-permission-title">{row.title}</div>
                    <div className="chat-permission-options">
                      {row.options.map((o) => (
                        <button
                          key={o.optionId}
                          disabled={row.decided != null}
                          className={
                            row.decided === o.optionId
                              ? "chat-permission-chosen"
                              : ""
                          }
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
          {activity && <div className="chat-activity">{activity}…</div>}
        </div>
      </div>

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
