import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IDockviewPanelProps } from "dockview-react";
import { ensureShorikaiTheme, monaco } from "../monacoSetup";
import {
  bannerFor,
  ensureLsp,
  installHint,
  installServer,
  langForPath,
  subscribeLsp,
} from "../lsp";
import { useProjectRoot } from "../projects";
import { getBreakpoints, getDebug, subscribeDebug, toggleBreakpoint } from "../debug";
import { setCursor } from "../vitals";
import { useVimMode } from "../vimMode";
import { useRelativeLineNumbers } from "../editorSettings";
import { bus } from "../bus";
import { getGitFor, subscribeGit } from "../gitStore";

const langDisplay = (id: string) =>
  ({ typescript: "TypeScript", javascript: "JavaScript", json: "JSON", css: "CSS", html: "HTML", go: "Go", rust: "Rust", markdown: "Markdown", python: "Python", shell: "Shell", yaml: "YAML" })[id] ??
  id.charAt(0).toUpperCase() + id.slice(1);

function LspBanner({ root, path }: { root: string; path: string }) {
  const banner = useSyncExternalStore(subscribeLsp, () =>
    bannerFor(root, langForPath(path)),
  );
  if (!banner) return null;
  return (
    <div className="lsp-banner">
      {banner.state === "installing" ? (
        <>
          <span className="tool-spinner" />
          <span>
            installing <b>{banner.cfg.command}</b>… this can take a minute
          </span>
        </>
      ) : (
        <>
          <span>
            <b>{banner.cfg.command}</b> language server not found
            {banner.state === "failed" && " — install failed"}
          </span>
          {banner.cfg.install && (
            <button
              className="lsp-banner-install"
              onClick={() => installServer(root, banner.server)}
            >
              Install via {banner.cfg.install.tool}
            </button>
          )}
          <span className="lsp-banner-hint">
            manual: <code>{installHint(banner.cfg)}</code>
          </span>
        </>
      )}
      {banner.state === "failed" && banner.error && (
        <pre className="lsp-banner-error">{banner.error}</pre>
      )}
    </div>
  );
}

// Saved-version bookkeeping survives pane unmounts (e.g. rail collapse):
// models are kept alive so dirty edits and undo history come back.
const savedVersions = new Map<string, number>();

type Params = { path: string; line?: number; nonce?: number };
type VimState = "normal" | "insert";

function wordPosition(
  model: monaco.editor.ITextModel,
  pos: monaco.IPosition,
  kind: "next" | "prev" | "end",
) {
  const text = model.getValue();
  const offset = model.getOffsetAt(pos);
  const words = text.matchAll(/[A-Za-z0-9_]+/g);
  let prev = 0;
  for (const match of words) {
    const start = match.index;
    const end = start + match[0].length;
    if (kind === "next" && start > offset) return model.getPositionAt(start);
    if (kind === "end" && end > offset + 1) return model.getPositionAt(end);
    if (kind === "prev" && start < offset) prev = start;
  }
  return model.getPositionAt(kind === "prev" ? prev : text.length);
}

const lazyLineNumbers = (current: number) => (line: number) =>
  line === current ? String(line) : String(Math.abs(line - current));

export function EditorPane(props: IDockviewPanelProps<Params>) {
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const vimEnabled = useVimMode();
  const relativeLines = useRelativeLineNumbers();
  const relativeLinesRef = useRef(relativeLines);
  const vimEnabledRef = useRef(vimEnabled);
  const vimStateRef = useRef<VimState>(vimEnabled ? "normal" : "insert");
  const vimPendingRef = useRef("");
  const [error, setError] = useState<string | null>(null);
  const [blameActive, setBlameActive] = useState(false);
  const blameActiveRef = useRef(false);
  const blameDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const blameHashesRef = useRef(new Map<number, string>());
  const root = useProjectRoot();
  const gitHead = useSyncExternalStore(subscribeGit, () => getGitFor(root)?.head ?? "");

  useEffect(() => { blameActiveRef.current = blameActive; }, [blameActive]);

  useEffect(() => {
    vimEnabledRef.current = vimEnabled;
    vimStateRef.current = vimEnabled ? "normal" : "insert";
    vimPendingRef.current = "";
    editorRef.current?.updateOptions({ cursorStyle: vimEnabled ? "block" : "line" });
  }, [vimEnabled]);

  useEffect(() => {
    relativeLinesRef.current = relativeLines;
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({
      lineNumbers: relativeLines
        ? lazyLineNumbers(editor.getPosition()?.lineNumber ?? 1)
        : "on",
    });
  }, [relativeLines]);

  const revealLine = (line: number | undefined) => {
    const editor = editorRef.current;
    if (editor && line != null) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
  };

  useEffect(() => {
    ensureShorikaiTheme();
    const path = props.params.path;
    const name = path.split("/").pop() ?? path;
    let observer: ResizeObserver | undefined;
    let activeSub: { dispose(): void } | undefined;
    let vimKeySub: { dispose(): void } | undefined;
    let debugSub: (() => void) | undefined;
    let disposed = false;

    invoke<string>("fs_read", { path }).then(
      (text) => {
        if (disposed) return;
        const uri = monaco.Uri.file(path);
        let model = monaco.editor.getModel(uri);
        if (!model) {
          model = monaco.editor.createModel(text, undefined, uri);
          savedVersions.set(path, model.getAlternativeVersionId());
        }
        ensureLsp(root, model);
        const editor = monaco.editor.create(ref.current!, {
          model,
          theme: "shorikai",
          fontFamily: getComputedStyle(document.documentElement)
            .getPropertyValue("--font-mono")
            .trim(),
          fontSize: 12.5,
          lineHeight: 19,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          padding: { top: 8 },
          renderLineHighlight: "line",
          fixedOverflowWidgets: true,
          glyphMargin: true,
          lineNumbers: relativeLinesRef.current ? lazyLineNumbers(1) : "on",
        });
        editorRef.current = editor;

        const enterVim = (state: VimState) => {
          vimStateRef.current = state;
          editor.updateOptions({ cursorStyle: state === "normal" ? "block" : "line" });
        };
        const moveTo = (line: number, column: number) => {
          const l = Math.min(Math.max(1, line), model!.getLineCount());
          const c = Math.min(Math.max(1, column), model!.getLineMaxColumn(l));
          editor.setPosition({ lineNumber: l, column: c });
          editor.revealPositionInCenterIfOutsideViewport({ lineNumber: l, column: c });
        };
        const moveWord = (kind: "next" | "prev" | "end") => {
          const pos = editor.getPosition();
          if (pos) editor.setPosition(wordPosition(model!, pos, kind));
        };
        const deleteChar = () => {
          const pos = editor.getPosition();
          if (!pos || pos.column >= model!.getLineMaxColumn(pos.lineNumber)) return;
          editor.executeEdits("vim", [
            {
              range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column + 1),
              text: "",
            },
          ]);
        };
        const deleteLine = () => {
          const pos = editor.getPosition();
          if (!pos) return;
          const last = pos.lineNumber === model!.getLineCount();
          editor.executeEdits("vim", [
            {
              range: last
                ? new monaco.Range(pos.lineNumber, 1, pos.lineNumber, model!.getLineMaxColumn(pos.lineNumber))
                : new monaco.Range(pos.lineNumber, 1, pos.lineNumber + 1, 1),
              text: "",
            },
          ]);
          moveTo(pos.lineNumber, 1);
        };
        vimKeySub = editor.onKeyDown((e) => {
          if (!vimEnabledRef.current) return;
          const ev = e.browserEvent;
          if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
          if (ev.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            vimPendingRef.current = "";
            enterVim("normal");
            return;
          }
          if (vimStateRef.current === "insert") return;
          e.preventDefault();
          e.stopPropagation();
          const pos = editor.getPosition();
          if (!pos) return;
          const pending = vimPendingRef.current;
          vimPendingRef.current = "";

          if (pending === "g" && ev.key === "g") return moveTo(1, pos.column);
          if (pending === "d" && ev.key === "d") return deleteLine();
          if (ev.key === "g" || ev.key === "d") {
            vimPendingRef.current = ev.key;
            return;
          }

          if (ev.key === "i") return enterVim("insert");
          if (ev.key === "a") {
            moveTo(pos.lineNumber, pos.column + 1);
            return enterVim("insert");
          }
          if (ev.key === "I") {
            const first = (model!.getLineContent(pos.lineNumber).search(/\S/) + 1) || 1;
            moveTo(pos.lineNumber, first);
            return enterVim("insert");
          }
          if (ev.key === "A") {
            moveTo(pos.lineNumber, model!.getLineMaxColumn(pos.lineNumber));
            return enterVim("insert");
          }
          if (ev.key === "o") {
            editor.trigger("vim", "editor.action.insertLineAfter", null);
            return enterVim("insert");
          }
          if (ev.key === "O") {
            editor.trigger("vim", "editor.action.insertLineBefore", null);
            return enterVim("insert");
          }
          if (ev.key === "h") return moveTo(pos.lineNumber, pos.column - 1);
          if (ev.key === "j") return moveTo(pos.lineNumber + 1, pos.column);
          if (ev.key === "k") return moveTo(pos.lineNumber - 1, pos.column);
          if (ev.key === "l") return moveTo(pos.lineNumber, pos.column + 1);
          if (ev.key === "ArrowLeft") return moveTo(pos.lineNumber, pos.column - 1);
          if (ev.key === "ArrowDown") return moveTo(pos.lineNumber + 1, pos.column);
          if (ev.key === "ArrowUp") return moveTo(pos.lineNumber - 1, pos.column);
          if (ev.key === "ArrowRight") return moveTo(pos.lineNumber, pos.column + 1);
          if (ev.key === "0") return moveTo(pos.lineNumber, 1);
          if (ev.key === "^") {
            const first = (model!.getLineContent(pos.lineNumber).search(/\S/) + 1) || 1;
            return moveTo(pos.lineNumber, first);
          }
          if (ev.key === "$") return moveTo(pos.lineNumber, model!.getLineMaxColumn(pos.lineNumber));
          if (ev.key === "G") return moveTo(model!.getLineCount(), pos.column);
          if (ev.key === "w") return moveWord("next");
          if (ev.key === "b") return moveWord("prev");
          if (ev.key === "e") return moveWord("end");
          if (ev.key === "x") return deleteChar();
          if (ev.key === "u") return editor.trigger("vim", "undo", null);
        });
        enterVim(vimStateRef.current);

        // gutter click toggles a breakpoint
        editor.onMouseDown((e) => {
          const t = e.target;
          const blameHash = t.position && blameHashesRef.current.get(t.position.lineNumber);
          if (blameHash && t.element?.classList.contains("git-blame-glyph")) {
            bus.openGit("history", blameHash);
            return;
          }
          if (
            (t.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
              t.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) &&
            t.position
          ) {
            toggleBreakpoint(path, t.position.lineNumber);
          }
        });
        const decorations = editor.createDecorationsCollection();
        blameDecorationsRef.current = editor.createDecorationsCollection();
        const renderDebugDecorations = () => {
          const items: monaco.editor.IModelDeltaDecoration[] = [];
          for (const line of getBreakpoints(path) ?? []) {
            items.push({
              range: new monaco.Range(line, 1, line, 1),
              options: {
                glyphMarginClassName: "bp-glyph",
                stickiness:
                  monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            });
          }
          const { paused } = getDebug();
          if (paused?.path === path && paused.line) {
            items.push({
              range: new monaco.Range(paused.line, 1, paused.line, 1),
              options: {
                isWholeLine: true,
                className: "debug-paused-line",
                glyphMarginClassName: "paused-glyph",
              },
            });
          }
          decorations.set(items);
        };
        renderDebugDecorations();
        debugSub = subscribeDebug(renderDebugDecorations);

        const syncTitle = () => {
          const dirty =
            model!.getAlternativeVersionId() !== savedVersions.get(path);
          props.api.setTitle(dirty ? `● ${name}` : name);
        };
        syncTitle();
        model.onDidChangeContent(() => {
          syncTitle();
          if (blameActiveRef.current) blameDecorationsRef.current?.clear();
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
          try {
            await invoke("fs_write", { path, contents: model!.getValue() });
            savedVersions.set(path, model!.getAlternativeVersionId());
            props.api.setTitle(name);
            if (blameActiveRef.current) void loadBlame();
          } catch (err) {
            setError(`save failed: ${err}`);
          }
        });

        // cursor line:col of the focused editor feeds the status bar
        const reportCursor = () => {
          const pos = editor.getPosition();
          if (pos) {
            if (relativeLinesRef.current) {
              editor.updateOptions({ lineNumbers: lazyLineNumbers(pos.lineNumber) });
            }
            setCursor({
              line: pos.lineNumber,
              col: pos.column,
              lang: langDisplay(model!.getLanguageId()),
            });
          }
        };
        editor.onDidChangeCursorPosition(() => {
          if (editor.hasTextFocus()) reportCursor();
        });
        editor.onDidFocusEditorText(reportCursor);

        observer = new ResizeObserver(() => editor.layout());
        observer.observe(ref.current!);
        activeSub = props.api.onDidActiveChange(({ isActive }) => {
          if (isActive) editor.focus();
        });
        if (props.api.isActive) editor.focus();
        revealLine(props.params.line);
      },
      (err) => setError(String(err)),
    );

    return () => {
      disposed = true;
      observer?.disconnect();
      activeSub?.dispose();
      vimKeySub?.dispose();
      debugSub?.();
      editorRef.current?.dispose();
      editorRef.current = null;
      blameDecorationsRef.current = null;
      // model intentionally kept: reopening restores dirty edits + undo stack
    };
  }, []);

  useEffect(() => {
    revealLine(props.params.line);
  }, [props.params.line, props.params.nonce]);

  const loadBlame = async () => {
    const relative = props.params.path.startsWith(`${root}/`) ? props.params.path.slice(root.length + 1) : props.params.path;
    try {
      const lines = await invoke<Array<{ line: number; hash: string; author: string; timestamp: number }>>("git_blame", { root, path: relative, ignoreWhitespace: false });
      blameHashesRef.current = new Map(lines.map((line) => [line.line, line.hash]));
      blameDecorationsRef.current?.set(lines.map((line) => ({
        range: new monaco.Range(line.line, 1, line.line, 1),
        options: {
          glyphMarginClassName: "git-blame-glyph",
          glyphMarginHoverMessage: { value: `${line.author} · ${new Date(line.timestamp * 1000).toLocaleString()} · ${line.hash}` },
          after: { content: `  ${line.author} · ${line.hash.slice(0, 8)}`, inlineClassName: "git-blame-annotation" },
        },
      })));
      setBlameActive(true);
    } catch (reason) { setError(`blame failed: ${reason}`); }
  };

  const toggleBlame = async () => {
    if (blameActive) {
      blameDecorationsRef.current?.clear();
      blameHashesRef.current.clear();
      setBlameActive(false);
      return;
    }
    await loadBlame();
  };

  useEffect(() => {
    if (blameActive) void loadBlame();
  }, [gitHead]);

  const openFileHistory = () => {
    const path = props.params.path.startsWith(`${root}/`)
      ? props.params.path.slice(root.length + 1)
      : props.params.path;
    bus.openGit("file", path);
  };

  return (
    <div className="editor-pane">
      <LspBanner root={root} path={props.params.path} />
      {error ? <div className="editor-error">{error}</div> : null}
      <button className="editor-history-toggle" onClick={openFileHistory}>File History</button>
      <button className={`editor-blame-toggle${blameActive ? " active" : ""}`} onClick={toggleBlame}>{blameActive ? "Hide blame" : "Blame"}</button>
      <div ref={ref} className="editor-host" />
    </div>
  );
}
