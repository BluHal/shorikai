import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolCard, ToolContentItem, ToolRow } from "./ToolCard";
import { mdComponentsFor } from "./mdComponents";
import { setAgentStatus, useProjectRoot } from "../projects";
import { getGitFor, GitStatus, subscribeGit, trackGitRoot } from "../gitStore";
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

type SlashCommand = {
  name: string;
  description: string;
  input?: { hint?: string } | null;
};

type Attachment = { id: number; mediaType: string; data: string };

type ClaudeSession = {
  sessionId: string;
  title: string;
  updatedAt: number;
};

type ReviewFile = {
  path: string;
  staged: string | null;
  unstaged: string | null;
  fresh: boolean;
};

type Row =
  | {
      kind: "user";
      text: string;
      queued?: boolean;
      qid?: number;
      mentions?: string[];
      images?: Attachment[];
    }
  | { kind: "agent"; text: string; done: boolean }
  | { kind: "thought"; text: string; done: boolean; open?: boolean }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "system"; text: string; restart?: boolean }
  | { kind: "team"; ids: string[] }
  | {
      kind: "turn_review";
      files: ReviewFile[];
      beforeCount: number;
      afterCount: number;
      noChange: boolean;
    }
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
  modes?: {
    currentModeId: string;
    availableModes: { id: string; name: string; description?: string | null }[];
  };
  models?: { currentModelId: string; availableModels: { modelId: string; name: string }[] };
  configOptions?: SessionConfigOption[];
};

type SessionConfigValue = {
  value: string;
  name: string;
  description?: string | null;
};

type SessionConfigOption = {
  id: string;
  name: string;
  category?: string | null;
  description?: string | null;
  currentValue: string;
  options: (SessionConfigValue | { group: string; name: string; options: SessionConfigValue[] })[];
};

type AcpEvent = {
  kind:
    | "session_ready"
    | "user_text"
    | "agent_text"
    | "agent_thought"
    | "tool_call"
    | "plan"
    | "sub_agent_update"
    | "config_options"
    | "available_commands"
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
  commands?: SlashCommand[];
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

const agentStorageKey = (root: string) => `shorikai.agent:${root}`;
const modeStorageKey = (root: string, agent: string) =>
  `shorikai.agent-mode:${root}:${agent}`;

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

const gitKey = (f: { path: string; staged: string | null; unstaged: string | null }) =>
  `${f.path}:${f.staged ?? " "}:${f.unstaged ?? " "}`;

const gitSnapshot = (git: GitStatus | null) =>
  new Set((git?.files ?? []).map(gitKey));

const isEditLikeTool = (u: ToolUpdate) =>
  [u.kind, u.title, u.toolCallId]
    .filter((x): x is string => !!x)
    .some((x) => /(edit|write|patch|apply|update|create|delete)/i.test(x));

const claimsChange = (text: string) =>
  /\b(implemented|updated|changed|created|deleted|fixed|patched|wrote|modified)\b/i.test(text);

const configValues = (o?: SessionConfigOption) =>
  o?.options.flatMap((v) => ("options" in v ? v.options : [v])) ?? [];

/// App-styled replacement for a native <select>: button + popup list.
function Dropdown(props: {
  value: string;
  options: { value: string; label: string; description?: string | null }[];
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
              title={o.description ?? undefined}
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
  const [agent, setAgent] = useState(
    () => localStorage.getItem(agentStorageKey(root)) ?? "claude-code",
  );
  const [agents, setAgents] = useState<Record<string, AgentConfig>>({});
  const [history, setHistory] = useState<ClaudeSession[]>([]);
  const [config, setConfig] = useState<ConfigState>({});
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [cmdSel, setCmdSel] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const [fileHits, setFileHits] = useState<string[]>([]);
  const [fileSel, setFileSel] = useState(0);
  const [fileDismissed, setFileDismissed] = useState(false);
  // every path ever picked via @; send() links the ones still in the text
  const mentionsRef = useRef<string[]>([]);
  const [images, setImages] = useState<Attachment[]>([]);
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
  const preTurnGitRef = useRef<GitStatus | null>(null);
  const turnHadEditToolRef = useRef(false);
  const turnAgentTextRef = useRef("");
  const handoffAfterTurnRef = useRef(false);
  const seedFromHandoffRef = useRef(false);
  // messages typed while the agent was busy, sent one per turn end
  const queueRef = useRef<
    { qid: number; text: string; mentions: string[]; images: Attachment[] }[]
  >([]);
  const nextQidRef = useRef(1);
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

  const refreshHistory = () => {
    if (!agentRef.current.startsWith("claude")) return;
    invoke<ClaudeSession[]>("claude_session_history", { cwd: root })
      .then(setHistory)
      .catch(() => setHistory([]));
  };

  const rememberMode = (value: string) => {
    localStorage.setItem(modeStorageKey(root, agentRef.current), value);
  };

  const applyRememberedMode = (next: ConfigState) => {
    const wanted = localStorage.getItem(modeStorageKey(root, agentRef.current));
    if (!wanted || agentIdRef.current == null) return next;
    const modeOpt = next.configOptions?.find((o) => o.category === "mode");
    if (modeOpt && configValues(modeOpt).some((m) => m.value === wanted)) {
      if (modeOpt.currentValue !== wanted) {
        invoke("acp_set_config_option", {
          id: agentIdRef.current,
          configId: modeOpt.id,
          value: wanted,
        }).catch(() => {});
        return {
          ...next,
          configOptions: next.configOptions?.map((o) =>
            o.id === modeOpt.id ? { ...o, currentValue: wanted } : o,
          ),
        };
      }
      return next;
    }
    if (next.modes?.availableModes.some((m) => m.id === wanted)) {
      if (next.modes.currentModeId !== wanted) {
        invoke("acp_set_mode", {
          id: agentIdRef.current,
          modeId: wanted,
        }).catch(() => {});
        return {
          ...next,
          modes: { ...next.modes, currentModeId: wanted },
        };
      }
    }
    return next;
  };

  const readGit = () =>
    invoke<GitStatus>("git_status_cmd", { root }).catch(() => null);

  const addTurnReview = async () => {
    const before = preTurnGitRef.current;
    const after = await readGit();
    preTurnGitRef.current = null;
    const beforeSet = gitSnapshot(before);
    const afterFiles = after?.files ?? [];
    const afterSet = gitSnapshot(after);
    const changed =
      beforeSet.size !== afterSet.size ||
      [...afterSet].some((key) => !beforeSet.has(key));
    const noChange =
      !changed && (turnHadEditToolRef.current || claimsChange(turnAgentTextRef.current));
    turnHadEditToolRef.current = false;
    turnAgentTextRef.current = "";
    if (!after || (afterFiles.length === 0 && !noChange)) return;
    setRows((r) => [
      ...r,
      {
        kind: "turn_review",
        files: afterFiles.map((f) => ({
          path: f.path,
          staged: f.staged,
          unstaged: f.unstaged,
          fresh: !beforeSet.has(gitKey(f)),
        })),
        beforeCount: before?.files.length ?? 0,
        afterCount: afterFiles.length,
        noChange,
      },
    ]);
  };

  const finishHandoff = async () => {
    if (!handoffAfterTurnRef.current) return;
    handoffAfterTurnRef.current = false;
    try {
      await invoke<string>("fs_read", { path: `${root}/SESSION.md` });
      seedFromHandoffRef.current = true;
      restartSession();
    } catch {
      setRows((r) => [
        ...r,
        { kind: "system", text: "handoff did not create SESSION.md" },
      ]);
    }
  };

  const start = async (name = agentRef.current, resume?: string) => {
    setStatus("starting");
    subsRef.current = [];
    setSubs([]);
    setDrill(null);
    setConfig({});
    setCommands([]);
    sessionIdRef.current = "";
    setCtxTokens(null);
    queueRef.current = [];
    setRows((r) => r.filter((x) => !(x.kind === "user" && x.queued)));
    try {
      agentIdRef.current = await invoke<number>("acp_start", {
        agent: name,
        cwd: root,
        // effort is a claude-code SDK option; other agents don't understand it
        effort: name.startsWith("claude") ? effortRef.current : null,
        resume: resume ?? null,
      });
    } catch (err) {
      setStatus("dead");
      setRows((r) => [
        ...r,
        { kind: "system", text: `failed to start agent: ${err}`, restart: true },
      ]);
    }
  };

  const restartSession = (resume?: string) => {
    const oldId = agentIdRef.current;
    if (oldId != null) invoke("acp_kill", { id: oldId }).catch(() => {});
    agentIdRef.current = null;
    setRows([]);
    start(agentRef.current, resume);
  };

  const switchAgent = (name: string) => {
    if (name === agent) return;
    const oldId = agentIdRef.current;
    if (oldId != null) invoke("acp_kill", { id: oldId }).catch(() => {});
    agentIdRef.current = null;
    setAgent(name);
    localStorage.setItem(agentStorageKey(root), name);
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
          setRows((r) =>
            r.map((row) =>
              (row.kind === "agent" || row.kind === "thought") && !row.done
                ? { ...row, done: true }
                : row,
            ),
          );
          setStatus("ready");
          refreshUsage();
          refreshHistory();
          if (seedFromHandoffRef.current) {
            seedFromHandoffRef.current = false;
            sendText(
              "Read @SESSION.md first, then continue from that handoff. Start by stating the next concrete step.",
              ["SESSION.md"],
            );
          }
          break;
        case "user_text":
          setRows((r) => {
            const closed = r.map((row) =>
              (row.kind === "agent" || row.kind === "thought") && !row.done
                ? { ...row, done: true }
                : row,
            );
            const last = closed[closed.length - 1];
            if (last?.kind === "user" && !last.queued) {
              return [
                ...closed.slice(0, -1),
                { ...last, text: last.text + (ev.text ?? "") },
              ];
            }
            return [...closed, { kind: "user", text: ev.text ?? "" }];
          });
          break;
        case "agent_text":
          turnAgentTextRef.current += ev.text ?? "";
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
            if (isEditLikeTool(u)) turnHadEditToolRef.current = true;
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
          setConfig((c) =>
            applyRememberedMode({
              modes:
                o.modes ??
                (o.currentModeId && c.modes
                  ? { ...c.modes, currentModeId: o.currentModeId }
                  : c.modes),
              models: o.models ?? c.models,
              configOptions: o.configOptions ?? c.configOptions,
            }),
          );
          break;
        }
        case "available_commands":
          setCommands(ev.commands ?? []);
          break;
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
        case "turn_ended": {
          setRows((r) =>
            r.map((row) =>
              (row.kind === "agent" || row.kind === "thought") && !row.done
                ? { ...row, done: true }
                : row,
            ),
          );
          refreshUsage();
          const handoff = handoffAfterTurnRef.current;
          void (async () => {
            await addTurnReview();
            if (handoff) {
              await finishHandoff();
              return;
            }
            const next = queueRef.current.shift();
            if (next) {
              // re-appended un-queued by sendText, after the finished turn
              setRows((r) =>
                r.filter((x) => !(x.kind === "user" && x.qid === next.qid)),
              );
              sendText(next.text, next.mentions, next.images);
            } else {
              setStatus("ready");
              setAgentStatus(root, "attention"); // downgraded to idle if tab is active
            }
          })();
          break;
        }
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
    props.api?.setTitle(displayName(agentRef.current));
    refreshHistory();
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

  const sendText = (
    text: string,
    mentions: string[] = [],
    imgs: Attachment[] = [],
  ) => {
    setRows((r) => [...r, { kind: "user", text, mentions, images: imgs }]);
    setStatus("busy");
    setAgentStatus(root, "working");
    turnHadEditToolRef.current = false;
    turnAgentTextRef.current = "";
    const call = (async () => {
      preTurnGitRef.current = await readGit();
      return mentions.length || imgs.length
        ? invoke("acp_prompt_blocks", {
            id: agentIdRef.current,
            prompt: [
              ...(text ? [{ type: "text", text }] : []),
              ...mentions.map((p) => ({
                type: "resource_link",
                uri: `file://${root}/${p}`,
                name: p,
              })),
              ...imgs.map((im) => ({
                type: "image",
                data: im.data,
                mimeType: im.mediaType,
              })),
            ],
          })
        : invoke("acp_prompt", { id: agentIdRef.current, text });
    })();
    call.catch((err) => {
      setStatus("ready");
      setAgentStatus(root, "idle");
      setRows((r) => [...r, { kind: "system", text: `error: ${err}` }]);
    });
  };

  const send = () => {
    const text = input.trim();
    if ((!text && images.length === 0) || status === "dead" || status === "starting")
      return;
    const mentions = mentionsRef.current.filter((p) => text.includes(`@${p}`));
    const imgs = images;
    setInput("");
    setImages([]);
    if (status === "busy") {
      const qid = nextQidRef.current++;
      queueRef.current.push({ qid, text, mentions, images: imgs });
      setRows((r) => [
        ...r,
        { kind: "user", text, queued: true, qid, mentions, images: imgs },
      ]);
      return;
    }
    sendText(text, mentions, imgs);
  };

  const handoff = () => {
    if (status !== "ready") return;
    handoffAfterTurnRef.current = true;
    sendText(
      [
        "Update or create SESSION.md in the repo root as a concise handoff for a fresh agent session.",
        "Include: current goal, what changed, why, files touched, known failures, commands run, and the next concrete step.",
        "Only edit SESSION.md.",
      ].join("\n"),
    );
  };

  const removeQueued = (qid: number) => {
    queueRef.current = queueRef.current.filter((q) => q.qid !== qid);
    setRows((r) => r.filter((x) => !(x.kind === "user" && x.qid === qid)));
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
    rememberMode(modeId);
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

  const setConfigOption = (configId: string, value: string) => {
    invoke("acp_set_config_option", {
      id: agentIdRef.current,
      configId,
      value,
    }).catch(() => {});
    setConfig((c) => ({
      ...c,
      configOptions: c.configOptions?.map((o) =>
        o.id === configId ? { ...o, currentValue: value } : o,
      ),
    }));
  };

  const setModeConfigOption = (configId: string, value: string) => {
    rememberMode(value);
    setConfigOption(configId, value);
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
  const historyOptions = [
    { value: "__new", label: "new session" },
    { value: "__handoff", label: "handoff + new session" },
    ...history.map((h) => ({
      value: h.sessionId,
      label: `${new Date(h.updatedAt * 1000).toLocaleString()} · ${h.title}`,
    })),
  ];

  // slash-command popup: open while the first token is being typed
  const cmdQuery =
    input.startsWith("/") && !/[\s]/.test(input) ? input.slice(1) : null;
  const cmdMatches =
    cmdQuery != null && !cmdDismissed
      ? commands
          .filter((c) => c.name.toLowerCase().includes(cmdQuery.toLowerCase()))
          .slice(0, 8)
      : [];
  const cmdIndex = Math.min(cmdSel, Math.max(cmdMatches.length - 1, 0));

  const pickCommand = (c: SlashCommand) => {
    setInput(`/${c.name} `);
    setCmdSel(0);
  };

  // @-file mentions: popup while the trailing @token is being typed
  const fileQuery = /(?:^|\s)@(\S*)$/.exec(input)?.[1] ?? null;
  const fileMatches = fileQuery != null && !fileDismissed ? fileHits.slice(0, 8) : [];
  const fileIndex = Math.min(fileSel, Math.max(fileMatches.length - 1, 0));

  useEffect(() => {
    if (fileQuery == null) return;
    const t = setTimeout(() => {
      invoke<string[]>("ws_fuzzy", { root, query: fileQuery })
        .then((hits) => {
          setFileHits(hits);
          setFileSel(0);
        })
        .catch(() => setFileHits([]));
    }, 60);
    return () => clearTimeout(t);
  }, [fileQuery, root]);

  const pickFile = (path: string) => {
    if (!mentionsRef.current.includes(path)) mentionsRef.current.push(path);
    setInput((v) => v.replace(/@\S*$/, `@${path} `));
    setFileSel(0);
  };

  const attachImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string; // data:image/png;base64,…
      const comma = url.indexOf(",");
      const mediaType = url.slice(5, url.indexOf(";"));
      setImages((im) => [
        ...im,
        { id: nextQidRef.current++, mediaType, data: url.slice(comma + 1) },
      ]);
    };
    reader.readAsDataURL(file);
  };

  const advertised = config.models?.availableModels ?? [];
  const configOption = (category: string) =>
    config.configOptions?.find((o) => o.category === category);
  const modeDescription = (id: string, description?: string | null) =>
    description ??
    {
      ":read-only":
        "Codex can read files in the current workspace. Approval is required to edit files or access the internet.",
      "read-only":
        "Codex can read files in the current workspace. Approval is required to edit files or access the internet.",
      ":workspace":
        "Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files.",
      workspace:
        "Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files.",
      ":danger-full-access":
        "Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.",
      "danger-full-access":
        "Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.",
    }[id];
  const modeConfig = configOption("mode");
  const modelConfig = configOption("model");
  const effortConfig = configOption("thought_level");
  const openReviewDiff = (path: string) => {
    invoke<{ old_text: string; new_text: string }>("git_diff", { root, path }).then(
      (d) => bus.openDiff(`${root}/${path}`, d.old_text, d.new_text),
      () => {},
    );
  };
  const reviewLetter = (f: ReviewFile) =>
    f.unstaged === "?" ? "U" : f.unstaged ?? f.staged ?? "M";
  const modelOptions = modelConfig
    ? configValues(modelConfig).map((m) => ({
        value: m.value,
        label: m.name,
        description: m.description,
      }))
    : config.models
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
            {agent.startsWith("claude") && history.length > 0 && (
              <Dropdown
                title="Resume session"
                value="history"
                options={historyOptions}
                onChange={(id) => {
                  if (id === "__handoff") handoff();
                  else restartSession(id === "__new" ? undefined : id);
                }}
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
                  <div
                    key={i}
                    className={`chat-user${row.queued ? " chat-user-queued" : ""}`}
                  >
                    <span className="chat-user-label">
                      {row.queued ? "queued" : "you"}
                    </span>
                    <div className="chat-user-bubble">
                      {row.text}
                      {row.queued && (
                        <button
                          className="chat-queue-remove"
                          title="Remove from queue"
                          onClick={() => removeQueued(row.qid!)}
                        >
                          ×
                        </button>
                      )}
                      {(row.images?.length ?? 0) > 0 && (
                        <div className="chat-mentions">
                          {row.images!.map((im) => (
                            <img
                              key={im.id}
                              className="chat-bubble-image"
                              src={`data:${im.mediaType};base64,${im.data}`}
                              alt="attachment"
                            />
                          ))}
                        </div>
                      )}
                      {(row.mentions?.length ?? 0) > 0 && (
                        <div className="chat-mentions">
                          {row.mentions!.map((p) => (
                            <span key={p} className="chat-mention-chip" title={p}>
                              @{p.split("/").pop()}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
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
              case "turn_review":
                return (
                  <div key={i} className="turn-review">
                    <div className="turn-review-head">
                      <span>Turn review</span>
                      <span>
                        {row.beforeCount} → {row.afterCount} working tree files
                      </span>
                    </div>
                    {row.noChange && (
                      <div className="turn-review-note">
                        No file changes detected for this edit-like turn.
                      </div>
                    )}
                    {row.files.length > 0 && (
                      <div className="turn-review-files">
                        {row.files.map((f) => (
                          <button
                            key={f.path}
                            className={`turn-review-file${f.fresh ? " turn-review-fresh" : ""}`}
                            title={f.path}
                            onClick={() => openReviewDiff(f.path)}
                          >
                            <span>{reviewLetter(f)}</span>
                            <span>{f.path}</span>
                          </button>
                        ))}
                      </div>
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
        {cmdMatches.length > 0 && (
          <div className="chat-cmd-menu">
            {cmdMatches.map((c, j) => (
              <button
                key={c.name}
                className={`chat-cmd-item${j === cmdIndex ? " chat-cmd-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focus
                  pickCommand(c);
                }}
              >
                <span className="chat-cmd-name">/{c.name}</span>
                {c.input?.hint && (
                  <span className="chat-cmd-hint">{c.input.hint}</span>
                )}
                <span className="chat-cmd-desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}
        {fileMatches.length > 0 && (
          <div className="chat-cmd-menu">
            {fileMatches.map((p, j) => (
              <button
                key={p}
                className={`chat-cmd-item${j === fileIndex ? " chat-cmd-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focus
                  pickFile(p);
                }}
              >
                <span className="chat-cmd-name">@{p.split("/").pop()}</span>
                <span className="chat-cmd-desc">{p}</span>
              </button>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="chat-attachments">
            {images.map((im) => (
              <span key={im.id} className="chat-attachment">
                <img
                  src={`data:${im.mediaType};base64,${im.data}`}
                  alt="attachment"
                />
                <button
                  title="Remove image"
                  onClick={() =>
                    setImages((list) => list.filter((x) => x.id !== im.id))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          className="chat-input"
          rows={2}
          value={input}
          onPaste={(e) => {
            const files = [...e.clipboardData.items]
              .filter((it) => it.type.startsWith("image/"))
              .map((it) => it.getAsFile())
              .filter((f): f is File => f != null);
            if (files.length) {
              e.preventDefault();
              files.forEach(attachImage);
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const files = [...e.dataTransfer.files].filter((f) =>
              f.type.startsWith("image/"),
            );
            if (files.length) {
              e.preventDefault();
              files.forEach(attachImage);
            }
          }}
          placeholder={
            status === "ready"
              ? `message ${displayName(agent).toLowerCase()} — enter to send`
              : status === "busy"
                ? "working — enter queues for the next turn"
                : statusText[status]
          }
          disabled={status === "dead"}
          onChange={(e) => {
            setInput(e.target.value);
            setCmdDismissed(false);
            setFileDismissed(false);
          }}
          onKeyDown={(e) => {
            if (cmdMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCmdSel((cmdIndex + 1) % cmdMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCmdSel((cmdIndex - 1 + cmdMatches.length) % cmdMatches.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                pickCommand(cmdMatches[cmdIndex]);
                return;
              }
              if (e.key === "Escape") {
                setCmdDismissed(true);
                return;
              }
            }
            if (fileMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setFileSel((fileIndex + 1) % fileMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setFileSel((fileIndex - 1 + fileMatches.length) % fileMatches.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                pickFile(fileMatches[fileIndex]);
                return;
              }
              if (e.key === "Escape") {
                setFileDismissed(true);
                return;
              }
            }
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
          {(modeConfig || config.modes) && (
            <Dropdown
              up
              title={
                modeConfig?.description ??
                config.modes?.availableModes.find((m) => m.id === config.modes?.currentModeId)
                  ?.description ??
                "Permission mode"
              }
              disabled={status === "dead"}
              value={modeConfig?.currentValue ?? config.modes!.currentModeId}
              options={
                modeConfig
                  ? configValues(modeConfig).map((m) => ({
                      value: m.value,
                      label: m.name,
                      description: modeDescription(m.value, m.description),
                    }))
                  : config.modes!.availableModes.map((m) => ({
                      value: m.id,
                      label: m.name,
                      description: modeDescription(m.id, m.description),
                    }))
              }
              onChange={(value) =>
                modeConfig ? setModeConfigOption(modeConfig.id, value) : setMode(value)
              }
            />
          )}
          {modelOptions && (
            <Dropdown
              up
              title={modelConfig?.description ?? "Model"}
              disabled={status === "dead"}
              value={modelConfig?.currentValue ?? config.models!.currentModelId}
              options={modelOptions}
              onChange={(value) =>
                modelConfig ? setConfigOption(modelConfig.id, value) : setModel(value)
              }
            />
          )}
          {(effortConfig || agent.startsWith("claude")) && (
            <Dropdown
              up
              title={
                effortConfig?.description ??
                (agent.startsWith("claude")
                  ? "Effort — changing restarts the session"
                  : "Reasoning effort")
              }
              disabled={status === "dead"}
              value={effortConfig?.currentValue ?? effort}
              options={
                effortConfig
                  ? configValues(effortConfig).map((e) => ({
                      value: e.value,
                      label: e.name,
                      description: e.description,
                    }))
                  : EFFORTS
              }
              onChange={(value) =>
                effortConfig
                  ? setConfigOption(effortConfig.id, value)
                  : changeEffort(value)
              }
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
