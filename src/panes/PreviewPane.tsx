import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { IDockviewPanelProps } from "dockview-react";
import { EditorPane } from "./EditorPane";
import { mdComponentsFor } from "./mdComponents";
import { ensureShorikaiTheme, monaco } from "../monacoSetup";
import { useProjectRoot } from "../projects";

export const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif)$/i;
export const MARKDOWN_EXT = /\.(md|markdown)$/i;
export const HTML_EXT = /\.(html?|htm)$/i;

type Mode = "markdown" | "html" | "image";

export function previewMode(path: string): Mode | null {
  if (IMAGE_EXT.test(path)) return "image";
  if (MARKDOWN_EXT.test(path)) return "markdown";
  if (HTML_EXT.test(path)) return "html";
  return null;
}

const langAliases: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  py: "python",
  rs: "rust",
  yml: "yaml",
};

/// fenced code blocks tokenized by monaco's colorizer (design-token theme)
function HighlightedCode(
  props: React.HTMLAttributes<HTMLElement> & { className?: string },
) {
  const lang = /language-([\w-]+)/.exec(props.className ?? "")?.[1];
  const text = String(props.children ?? "");
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!lang) return;
    const id = langAliases[lang] ?? lang;
    if (!monaco.languages.getLanguages().some((l) => l.id === id)) return;
    ensureShorikaiTheme();
    monaco.editor
      .colorize(text.replace(/\n$/, ""), id, { tabSize: 2 })
      .then(setHtml)
      .catch(() => {});
  }, [text, lang]);

  if (html != null) {
    return (
      <code
        className={`${props.className} monaco-colorized`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <code {...props} />;
}

export function PreviewPane(props: IDockviewPanelProps<{ path: string }>) {
  const path = props.params.path;
  const mode = previewMode(path) ?? "markdown";
  const root = useProjectRoot();
  const [showSource, setShowSource] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "image") return;
    let live = true;
    const load = () =>
      invoke<string>("fs_read", { path }).then(
        (text) => live && setContent(text),
        (err) => live && setError(String(err)),
      );
    load();
    // live-update as agents or shells rewrite the file
    const dir = path.slice(0, path.lastIndexOf("/"));
    const un = listen<{ paths: string[] }>("ws:changed", (e) => {
      if (e.payload.paths.includes(dir)) load();
    });
    return () => {
      live = false;
      un.then((u) => u());
    };
  }, [path, mode]);

  const FileRefCode = mdComponentsFor(root).code;
  const mdComponents = {
    code: (p: React.HTMLAttributes<HTMLElement> & { className?: string }) =>
      /language-/.test(p.className ?? "") || String(p.children ?? "").includes("\n") ? (
        <HighlightedCode {...p} />
      ) : (
        <FileRefCode {...p} />
      ),
  };

  return (
    <div className="preview-pane">
      <div className="preview-bar">
        <span className="preview-name">{path.split("/").pop()}</span>
        <span className="preview-mode">{showSource ? "source" : mode}</span>
        {mode !== "image" && (
          <button
            className="preview-toggle"
            onClick={() => setShowSource(!showSource)}
          >
            {showSource ? "◨ preview" : "⌗ source"}
          </button>
        )}
      </div>
      {showSource ? (
        <EditorPane {...(props as unknown as Parameters<typeof EditorPane>[0])} />
      ) : error ? (
        <div className="editor-error">{error}</div>
      ) : mode === "image" ? (
        <div className="preview-img-wrap">
          <img className="preview-img" src={convertFileSrc(path)} alt={path} />
        </div>
      ) : mode === "html" ? (
        <iframe
          className="preview-frame"
          title={path}
          sandbox=""
          srcDoc={content ?? ""}
        />
      ) : (
        <div className="preview-scroll">
          <div className="chat-md preview-md">
            <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {content ?? ""}
            </Markdown>
          </div>
        </div>
      )}
    </div>
  );
}
