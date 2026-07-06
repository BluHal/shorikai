import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolCard, ToolContentItem, ToolRow } from "./ToolCard";
import { mdComponentsFor } from "./mdComponents";
import { setAgentStatus, useProjectRoot } from "../projects";
import { getGitFor, subscribeGit, trackGitRoot } from "../gitStore";
import { bus } from "../bus";
import {
  AgentStrip,
  DrillBody,
  DrillCrumb,
  SubAgent,
  TeamCard,
} from "./SubAgents";

type PermissionOption = { optionId: string; name: string; kind?: string };

type PlanEntry = { content: string; status: string };

type Row =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string; done: boolean }
  | { kind: "thought"; text: string; done: boolean; open?: boolean }
  | { kind: "plan"; entries: PlanEntry[] }
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

type ConfigState = {
  modes?: { currentModeId: string; availableModes: { id: string; name: string }[] };
  models?: { currentModelId: string; availableModels: { modelId: string; name: string }[] };
};

type AcpEvent = {
  kind:
    | "session_ready"
    | "agent_text"
    | "agent_thought"
    | "tool_call"
    | "plan"
    | "sub_agent_update"
    | "config_options"
    | "permission_request"
    | "turn_ended"
    | "agent_exit"
    | "error";
  agent_id: number;
  session_id?: string;
  text?: string;
  update?: ToolUpdate & { entries?: PlanEntry[] };
  sub?: SubAgent;
  options?: ConfigState & { currentModeId?: string };
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

type AgentConfig = { command: string; args?: string[]; fallback?: string };

const displayName = (key: string) =>
  key
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

// current Claude lineup with exact ids; the adapter only advertises a couple
// of aliases, so these are merged into whatever it reports
const KNOWN_MODELS = [
  { modelId: "claude-fable-5", name: "Fable 5" },
  { modelId: "claude-opus-4-8", name: "Opus 4.8" },
  { modelId: "claude-opus-4-7", name: "Opus 4.7" },
  { modelId: "claude-opus-4-6", name: "Opus 4.6" },
  { modelId: "claude-sonnet-5", name: "Sonnet 5" },
  { modelId: "claude-sonnet-4-6", name: "Sonnet 4.6" },
  { modelId: "claude-haiku-4-5", name: "Haiku 4.5" },
];

// SDK session option; changing it requires a session restart
const EFFORTS = ["low", "medium", "high", "max"].map((e) => ({
  value: e,
  label: `effort: ${e}`,
}));

const fmtTokens = (n: number) =>
  n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

/// App-styled replacement for a native <select>: button + popup list.
function Dropdown(props: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  title?: string;
  disabled?: boolean;
  /// open the menu above the button (for controls at the bottom of the pane)
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = props.options.find((o) => o.value === props.value);
  return (
    <div className="chat-dd" ref={ref}>
      <button
        className="chat-dd-btn"
        title={props.title}
        disabled={props.disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.label ?? props.value}
        <span className="chat-dd-chev">{props.up ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className={`chat-dd-menu${props.up ? " chat-dd-up" : ""}`}>
          {props.options.map((o) => (
            <button
              key={o.value}
              className={`chat-dd-item${
                o.value === props.value ? " chat-dd-active" : ""
              }`}
              onClick={() => {
                setOpen(false);
                if (o.value !== props.value) props.onChange(o.value);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatPane(props: { api?: { setTitle(t: string): void } }) {
  const root = useProjectRoot();
  const mdComponents = mdComponentsFor(root);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<Status>("starting");
  const [input, setInput] = useState("");
  const [subs, setSubs] = useState<SubAgent[]>([]);
  const [drill, setDrill] = useState<string | null>(null);
  const [agent, setAgent] = useState("claude-code");
  const [agents, setAgents] = useState<Record<string, AgentConfig>>({});
  const [config, setConfig] = useState<ConfigState>({});
  const [effort, setEffort] = useState("high");
  const [ctxTokens, setCtxTokens] = useState<number | null>(null);
  const [plan, setPlan] = useState<{ utilization: number; resets_at: string } | null>(null);
  const git = useSyncExternalStore(subscribeGit, () => getGitFor(root));
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const agentIdRef = useRef<number | null>(null);
  const sessionIdRef = useRef("");
  const subsRef = useRef<SubAgent[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshUsage = () => {
    if (sessionIdRef.current && agentRef.current.startsWith("claude")) {
      invoke<{ context_tokens: number }>("claude_context_usage", {
        cwd: root,
        sessionId: sessionIdRef.current,
      })
        .then((u) => setCtxTokens(u.context_tokens))
        .catch(() => {});
    }
    invoke<{ five_hour?: { utilization: number; resets_at: string } }>("plan_usage")
      .then((u) => u.five_hour && setPlan(u.five_hour))
      .catch(() => {});
  };

  const start = async (name = agentRef.current) => {
    setStatus("starting");
    subsRef.current = [];
    setSubs([]);
    setDrill(null);
    setConfig({});
    sessionIdRef.current = "";
    setCtxTokens(null);
    try {
      agentIdRef.current = await invoke<number>("acp_start", {
        agent: name,
        cwd: root,
        // effort is a claude-code SDK option; other agents don't understand it
        effort: name.startsWith("claude") ? effortRef.current : null,
      });
    } catch (err) {
      setStatus("dead");
      setRows((r) => [
        ...r,
        { kind: "system", text: `failed to start agent: ${err}`, restart: true },
      ]);
    }
  };

  const switchAgent = (name: string) => {
    if (name === agent) return;
    const oldId = agentIdRef.current;
    if (oldId != null) invoke("acp_kill", { id: oldId }).catch(() => {});
    agentIdRef.current = null;
    setAgent(name);
    props.api?.setTitle(displayName(name));
    setRows([{ kind: "system", text: `switched to ${displayName(name)}` }]);
    start(name);
  };

  useEffect(() => {
    const unlisten = listen<AcpEvent>("acp:event", (e) => {
      const ev = e.payload;
      if (ev.agent_id !== agentIdRef.current) return;
      switch (ev.kind) {
        case "session_ready":
          sessionIdRef.current = ev.session_id ?? "";
          setStatus("ready");
          refreshUsage();
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
            // answer text ends the thinking block, collapsing it
            const closed =
              last?.kind === "thought" && !last.done
                ? [...r.slice(0, -1), { ...last, done: true }]
                : r;
            return [...closed, { kind: "agent", text: ev.text ?? "", done: false }];
          });
          break;
        case "agent_thought":
          setRows((r) => {
            const last = r[r.length - 1];
            if (last?.kind === "thought" && !last.done) {
              return [
                ...r.slice(0, -1),
                { ...last, text: last.text + (ev.text ?? "") },
              ];
            }
            return [...r, { kind: "thought", text: ev.text ?? "", done: false }];
          });
          break;
        case "tool_call":
          if (ev.update) {
            const u = ev.update;
            setRows((r) => applyToolUpdate(r, u));
          }
          break;
        case "plan": {
          const entries = ev.update?.entries ?? [];
          setRows((r) => {
            // one card per turn: update the last plan row of this turn in place
            for (let i = r.length - 1; i >= 0; i--) {
              if (r[i].kind === "user") break;
              if (r[i].kind === "plan") {
                const copy = [...r];
                copy[i] = { kind: "plan", entries };
                return copy;
              }
            }
            return [...r, { kind: "plan", entries }];
          });
          break;
        }
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
        case "config_options": {
          const o = ev.options ?? {};
          setConfig((c) => ({
            modes:
              o.modes ??
              (o.currentModeId && c.modes
                ? { ...c.modes, currentModeId: o.currentModeId }
                : c.modes),
            models: o.models ?? c.models,
          }));
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
              (row.kind === "agent" || row.kind === "thought") && !row.done
                ? { ...row, done: true }
                : row,
            ),
          );
          setStatus("ready");
          setAgentStatus(root, "attention"); // downgraded to idle if tab is active
          refreshUsage();
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
    invoke<Record<string, AgentConfig>>("acp_agents")
      .then(setAgents)
      .catch(() => {});
    trackGitRoot(root);
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

  // optimistic update; the agent's current_mode_update confirms or corrects
  const setMode = (modeId: string) => {
    invoke("acp_set_mode", { id: agentIdRef.current, modeId }).catch(() => {});
    setConfig((c) =>
      c.modes ? { ...c, modes: { ...c.modes, currentModeId: modeId } } : c,
    );
  };

  const setModel = (modelId: string) => {
    invoke("acp_set_model", { id: agentIdRef.current, modelId }).catch(() => {});
    setConfig((c) =>
      c.models ? { ...c, models: { ...c.models, currentModelId: modelId } } : c,
    );
  };

  // effort is fixed at session creation, so changing it restarts the session
  const changeEffort = (e: string) => {
    setEffort(e);
    effortRef.current = e;
    const oldId = agentIdRef.current;
    if (oldId != null) invoke("acp_kill", { id: oldId }).catch(() => {});
    agentIdRef.current = null;
    setRows((r) => [
      ...r,
      { kind: "system", text: `effort set to ${e} — new session` },
    ]);
    start();
  };

  const statusText: Record<Status, string> = {
    starting: "starting…",
    ready: "ready",
    busy: "working…",
    dead: "not running",
  };

  const drilledSub = drill ? subs.find((s) => s.id === drill) : undefined;

  const advertised = config.models?.availableModels ?? [];
  const modelOptions = config.models
    ? [
        ...advertised,
        ...KNOWN_MODELS.filter(
          (k) => !advertised.some((m) => m.modelId === k.modelId),
        ),
      ].map((m) => ({ value: m.modelId, label: m.name }))
    : null;

  return (
    <div className="chat-pane">
      <div className="chat-header">
        <span className="chat-avatar">&gt;_</span>
        <div className="chat-title">
          <span className="chat-name">
            {displayName(agent)}
            {Object.keys(agents).length > 1 && (
              <Dropdown
                title="Switch agent"
                value={agent}
                options={Object.keys(agents).map((name) => ({
                  value: name,
                  label: displayName(name),
                }))}
                onChange={switchAgent}
              />
            )}
          </span>
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
              case "thought": {
                const open = row.open ?? !row.done;
                return (
                  <div
                    key={i}
                    className="chat-thought"
                    onClick={() =>
                      setRows((r) =>
                        r.map((x) => (x === row ? { ...x, open: !open } : x)),
                      )
                    }
                  >
                    <span className="chat-thought-label">
                      {open ? "▾" : "▸"} {row.done ? "thought" : "thinking…"}
                    </span>
                    {open && <div className="chat-thought-text">{row.text}</div>}
                  </div>
                );
              }
              case "system":
                return (
                  <div key={i} className="chat-system">
                    <span>{row.text}</span>
                    {row.restart && (
                      <button className="chat-restart" onClick={() => start()}>
                        restart
                      </button>
                    )}
                    {row.restart && agents[agent]?.fallback && (
                      <button
                        className="chat-restart"
                        onClick={() =>
                          bus.openCliTerminal(agents[agent].fallback!, agent)
                        }
                      >
                        open {agent} in a terminal
                      </button>
                    )}
                  </div>
                );
              case "plan":
                return (
                  <div key={i} className="chat-plan">
                    <div className="chat-plan-title">Plan</div>
                    {row.entries.map((e, j) => (
                      <div key={j} className={`chat-plan-item chat-plan-${e.status}`}>
                        <span className="chat-plan-mark">
                          {e.status === "completed"
                            ? "✓"
                            : e.status === "in_progress"
                              ? "▸"
                              : "○"}
                        </span>
                        {e.content}
                      </div>
                    ))}
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
        <div className="chat-input-meta">
          {config.modes && (
            <Dropdown
              up
              title="Permission mode"
              disabled={status === "dead"}
              value={config.modes.currentModeId}
              options={config.modes.availableModes.map((m) => ({
                value: m.id,
                label: m.name,
              }))}
              onChange={setMode}
            />
          )}
          {modelOptions && (
            <Dropdown
              up
              title="Model"
              disabled={status === "dead"}
              value={config.models!.currentModelId}
              options={modelOptions}
              onChange={setModel}
            />
          )}
          {agent.startsWith("claude") && (
            <Dropdown
              up
              title="Effort — changing restarts the session"
              disabled={status === "dead"}
              value={effort}
              options={EFFORTS}
              onChange={changeEffort}
            />
          )}
          <span
            className="chat-context"
            title={[
              root,
              ctxTokens != null ? `${ctxTokens.toLocaleString()} context tokens in use` : "",
              plan ? `5h window resets ${new Date(plan.resets_at).toLocaleTimeString()}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            {ctxTokens != null ? `ctx ${fmtTokens(ctxTokens)} · ` : ""}
            {plan ? `5h ${Math.round(plan.utilization)}% · ` : ""}
            {root.split("/").pop()}
            {git?.branch ? ` · ⎇ ${git.branch}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
