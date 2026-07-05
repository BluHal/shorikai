import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IDockviewPanelProps } from "dockview-react";
import { monaco } from "../monacoSetup";

export function EditorPane(props: IDockviewPanelProps<{ path: string }>) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const path = props.params.path;
    const name = path.split("/").pop() ?? path;
    let editor: monaco.editor.IStandaloneCodeEditor | undefined;
    let model: monaco.editor.ITextModel | undefined;
    let observer: ResizeObserver | undefined;
    let disposed = false;

    invoke<string>("fs_read", { path }).then(
      (text) => {
        if (disposed) return;
        const uri = monaco.Uri.file(path);
        model = monaco.editor.getModel(uri) ?? undefined;
        if (!model) {
          model = monaco.editor.createModel(text, undefined, uri);
        }
        editor = monaco.editor.create(ref.current!, {
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

        let savedVersion = model.getAlternativeVersionId();
        model.onDidChangeContent(() => {
          const dirty = model!.getAlternativeVersionId() !== savedVersion;
          props.api.setTitle(dirty ? `● ${name}` : name);
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
          try {
            await invoke("fs_write", { path, contents: model!.getValue() });
            savedVersion = model!.getAlternativeVersionId();
            props.api.setTitle(name);
          } catch (err) {
            setError(`save failed: ${err}`);
          }
        });

        observer = new ResizeObserver(() => editor?.layout());
        observer.observe(ref.current!);

        const activeSub = props.api.onDidActiveChange(({ isActive }) => {
          if (isActive) editor?.focus();
        });
        if (props.api.isActive) editor.focus();
        // stash for cleanup
        (editor as unknown as { _activeSub: { dispose(): void } })._activeSub =
          activeSub;
      },
      (err) => setError(String(err)),
    );

    return () => {
      disposed = true;
      observer?.disconnect();
      (editor as unknown as { _activeSub?: { dispose(): void } })?._activeSub?.dispose();
      editor?.dispose();
      model?.dispose();
    };
  }, []);

  return (
    <div className="editor-pane">
      {error ? <div className="editor-error">{error}</div> : null}
      <div ref={ref} className="editor-host" />
    </div>
  );
}
