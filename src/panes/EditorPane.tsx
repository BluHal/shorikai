import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IDockviewPanelProps } from "dockview-react";
import { ensureShorikaiTheme, monaco } from "../monacoSetup";
import { ensureLsp } from "../lsp";
import { useProjectRoot } from "../projects";

// Saved-version bookkeeping survives pane unmounts (e.g. rail collapse):
// models are kept alive so dirty edits and undo history come back.
const savedVersions = new Map<string, number>();

type Params = { path: string; line?: number; nonce?: number };

export function EditorPane(props: IDockviewPanelProps<Params>) {
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useProjectRoot();

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
        });
        editorRef.current = editor;

        const syncTitle = () => {
          const dirty =
            model!.getAlternativeVersionId() !== savedVersions.get(path);
          props.api.setTitle(dirty ? `● ${name}` : name);
        };
        syncTitle();
        model.onDidChangeContent(syncTitle);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
          try {
            await invoke("fs_write", { path, contents: model!.getValue() });
            savedVersions.set(path, model!.getAlternativeVersionId());
            props.api.setTitle(name);
          } catch (err) {
            setError(`save failed: ${err}`);
          }
        });

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
      editorRef.current?.dispose();
      editorRef.current = null;
      // model intentionally kept: reopening restores dirty edits + undo stack
    };
  }, []);

  useEffect(() => {
    revealLine(props.params.line);
  }, [props.params.line, props.params.nonce]);

  return (
    <div className="editor-pane">
      {error ? <div className="editor-error">{error}</div> : null}
      <div ref={ref} className="editor-host" />
    </div>
  );
}
