import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mdComponents } from "./mdComponents";

export type SubAgent = {
  id: string;
  name: string;
  task: string;
  status: string; // working | done | failed
  activity: string;
  transcript: string[];
};

export function StatusGlyph({ status }: { status: string }) {
  if (status === "done") return <span className="sub-status-done">✓</span>;
  if (status === "failed") return <span className="sub-status-failed">!</span>;
  return <span className="sub-spinner" />;
}

function statusCounts(subs: SubAgent[]) {
  const working = subs.filter((s) => s.status === "working").length;
  const done = subs.filter((s) => s.status === "done").length;
  const failed = subs.filter((s) => s.status === "failed").length;
  return [
    working && `${working} working`,
    done && `${done} done`,
    failed && `${failed} need attention`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function AgentStrip(props: {
  subs: SubAgent[];
  onDrill: (id: string) => void;
}) {
  return (
    <div className="agent-strip">
      <span className="agent-strip-label">AGENTS</span>
      {props.subs.map((s) => (
        <div key={s.id} className="agent-chip" onClick={() => props.onDrill(s.id)}>
          <StatusGlyph status={s.status} />
          <span className="agent-chip-name">{s.name}</span>
          {(s.activity || s.status !== "working") && (
            <span className="agent-chip-activity">
              {s.status === "working" ? `${s.activity}…` : s.activity || s.task}
            </span>
          )}
        </div>
      ))}
      <span className="agent-strip-counts">{statusCounts(props.subs)}</span>
    </div>
  );
}

export function TeamCard(props: {
  ids: string[];
  subs: SubAgent[];
  onDrill: (id: string) => void;
}) {
  const members = props.ids
    .map((id) => props.subs.find((s) => s.id === id))
    .filter((s): s is SubAgent => s != null);
  return (
    <div className="team-card">
      <div className="team-card-header">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7">
          <circle cx="6" cy="6" r="2.4" />
          <circle cx="6" cy="18" r="2.4" />
          <circle cx="18" cy="8" r="2.4" />
          <path d="M6 8.4v7.2M8.4 6H14a3 3 0 0 1 3 3" />
        </svg>
        <span>
          Delegated to {members.length} agent{members.length === 1 ? "" : "s"}
        </span>
        <span className="team-card-hint">open a card to view its transcript</span>
      </div>
      <div className="team-grid">
        {members.map((s) => (
          <div key={s.id} className="team-member" onClick={() => props.onDrill(s.id)}>
            <div className="team-member-head">
              <span className={`team-initials team-initials-${s.status}`}>
                {s.name.slice(0, 2)}
              </span>
              <span className="team-member-name">{s.name}</span>
              <span className="team-member-status">
                <StatusGlyph status={s.status} />
                {s.status}
              </span>
            </div>
            <div className="team-member-task">{s.task}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DrillCrumb(props: { sub: SubAgent; onBack: () => void }) {
  return (
    <div className="drill-crumb">
      <span className="drill-back" onClick={props.onBack}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        chat
      </span>
      <span className="drill-sep">▸</span>
      <span className="drill-name">{props.sub.name}</span>
      <span className={`drill-status drill-status-${props.sub.status}`}>
        <StatusGlyph status={props.sub.status} />
        {props.sub.status}
      </span>
    </div>
  );
}

export function DrillBody({ sub }: { sub: SubAgent }) {
  return (
    <div className="drill-body">
      <div className="drill-head">
        <span className={`team-initials team-initials-${sub.status} drill-initials`}>
          {sub.name.slice(0, 2)}
        </span>
        <div className="drill-head-text">
          <span className="drill-head-name">{sub.name}</span>
          <span className="drill-head-meta">spawned by main</span>
        </div>
      </div>
      <div className="drill-task">
        <span className="drill-task-label">TASK</span>
        <div className="drill-task-text">{sub.task}</div>
      </div>
      {sub.transcript.length > 0 ? (
        <div className="chat-md drill-transcript">
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {sub.transcript.join("\n\n")}
          </Markdown>
        </div>
      ) : (
        <div className="drill-shallow">
          <StatusGlyph status={sub.status} />
          <span>
            {sub.status === "working"
              ? "working — this agent's stream is shallow"
              : "this agent reported no transcript"}
            {sub.activity && ` · last activity: ${sub.activity}`}
          </span>
        </div>
      )}
    </div>
  );
}
