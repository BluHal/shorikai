import { useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bus } from "../bus";
import {
  getGit,
  getGitRoot,
  GitFile,
  refreshGit,
  subscribeGit,
} from "../gitStore";

const statusClass = (s: string) =>
  s === "D" ? "git-del" : s === "M" || s === "R" ? "git-mod" : "git-add";

function openDiff(file: GitFile) {
  const root = getGitRoot();
  if (!root) return;
  invoke<{ old_text: string; new_text: string }>("git_diff", {
    root,
    path: file.path,
  }).then(
    (d) => bus.openDiff(`${root}/${file.path}`, d.old_text, d.new_text),
    () => {},
  );
}

function Row(props: {
  file: GitFile;
  letter: string;
  action: "stage" | "unstage";
  onAction: () => void;
}) {
  const { file, letter } = props;
  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length - 1);
  return (
    <div className="git-row" onClick={() => openDiff(file)}>
      <span className={`git-letter ${statusClass(letter)}`}>
        {letter === "?" ? "U" : letter}
      </span>
      <span className={`git-name ${statusClass(letter)}`}>{name}</span>
      {dir && <span className="git-dir">{dir}</span>}
      <button
        className="git-action"
        title={props.action}
        onClick={(e) => {
          e.stopPropagation();
          props.onAction();
        }}
      >
        {props.action === "stage" ? "+" : "−"}
      </button>
    </div>
  );
}

export function GitPanel() {
  const git = useSyncExternalStore(subscribeGit, getGit);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!git) {
    return <div className="sidebar-panel-empty">not a git repository</div>;
  }

  const staged = git.files.filter((f) => f.staged != null);
  const unstaged = git.files.filter((f) => f.unstaged != null);
  const root = getGitRoot();

  const act = (cmd: "git_stage" | "git_unstage", path: string) => {
    invoke(cmd, { root, path }).then(refreshGit, (e) => setError(String(e)));
  };

  const commit = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    invoke("git_commit", { root, message }).then(
      () => {
        setMessage("");
        setBusy(false);
        refreshGit();
      },
      (e) => {
        setError(String(e));
        setBusy(false);
      },
    );
  };

  return (
    <div className="git-panel">
      <div className="git-scroll">
        <div className="git-section-title">STAGED — {staged.length}</div>
        {staged.map((f) => (
          <Row
            key={`s:${f.path}`}
            file={f}
            letter={f.staged!}
            action="unstage"
            onAction={() => act("git_unstage", f.path)}
          />
        ))}
        {staged.length === 0 && <div className="git-empty">nothing staged</div>}

        <div className="git-section-title">CHANGES — {unstaged.length}</div>
        {unstaged.map((f) => (
          <Row
            key={`u:${f.path}`}
            file={f}
            letter={f.unstaged!}
            action="stage"
            onAction={() => act("git_stage", f.path)}
          />
        ))}
        {unstaged.length === 0 && (
          <div className="git-empty">working tree clean</div>
        )}
      </div>

      <div className="git-commit">
        {error && <div className="git-error">{error}</div>}
        <textarea
          className="git-message"
          rows={2}
          placeholder={`commit to ${git.branch}…`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) commit();
          }}
        />
        <button
          className="git-commit-btn"
          disabled={busy || staged.length === 0 || message.trim() === ""}
          title={
            staged.length === 0
              ? "nothing staged"
              : message.trim() === ""
                ? "message is empty"
                : "⌘Enter"
          }
          onClick={commit}
        >
          Commit
        </button>
      </div>
    </div>
  );
}
