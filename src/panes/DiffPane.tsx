import { useEffect, useRef } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ensureShorikaiTheme, monaco } from "../monacoSetup";

function langForPath(path: string): string | undefined {
  const ext = "." + (path.split(".").pop() ?? "");
  return monaco.languages
    .getLanguages()
    .find((l) => l.extensions?.includes(ext))?.id;
}

export function DiffPane(
  props: IDockviewPanelProps<{ path: string; oldText: string; newText: string }>,
) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureShorikaiTheme();
    const lang = langForPath(props.params.path);
    const original = monaco.editor.createModel(props.params.oldText, lang);
    const modified = monaco.editor.createModel(props.params.newText, lang);
    const editor = monaco.editor.createDiffEditor(ref.current!, {
      theme: "shorikai",
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim(),
      fontSize: 12.5,
      lineHeight: 19,
      minimap: { enabled: false },
      readOnly: true,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      automaticLayout: false,
    });
    editor.setModel({ original, modified });

    const observer = new ResizeObserver(() => editor.layout());
    observer.observe(ref.current!);

    return () => {
      observer.disconnect();
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, []);

  return <div ref={ref} className="editor-host" />;
}
