// Monaco bootstrap: bundled workers (no CDN — this is a desktop app) and the
// Shorikai theme derived from the design tokens.
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Theme definition is lazy: module evaluation happens before tokens.css is
// applied (main.tsx imports App — and this module — before the CSS), so the
// custom properties are only readable once a pane actually mounts.
let themeDefined = false;

export function ensureShorikaiTheme() {
  if (themeDefined) return;
  themeDefined = true;
  const css = getComputedStyle(document.documentElement);
  const tok = (name: string) => css.getPropertyValue(name).trim().replace("#", "");

  monaco.editor.defineTheme("shorikai", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: tok("--syn-keyword") },
      { token: "string", foreground: tok("--syn-string") },
      { token: "number", foreground: tok("--syn-num") },
      { token: "comment", foreground: tok("--syn-comment") },
      { token: "type", foreground: tok("--syn-type") },
      { token: "type.identifier", foreground: tok("--syn-type") },
      { token: "function", foreground: tok("--syn-func") },
      { token: "identifier", foreground: tok("--syn-plain") },
      { token: "delimiter", foreground: tok("--syn-punct") },
    ],
    colors: {
      "editor.background": `#${tok("--bg")}`,
      "editor.foreground": `#${tok("--syn-plain")}`,
      "editorLineNumber.foreground": `#${tok("--text-4")}`,
      "editorLineNumber.activeForeground": `#${tok("--text-2")}`,
      "editorCursor.foreground": `#${tok("--text-1")}`,
      "editor.selectionBackground": "#3fbecb42",
      "editor.lineHighlightBackground": `#${tok("--surface-1")}`,
      "editorWidget.background": `#${tok("--surface-2")}`,
      "editorWidget.border": `#${tok("--border")}`,
      "scrollbarSlider.background": "#2a2f3880",
      "scrollbarSlider.hoverBackground": "#353b4580",
    },
  });
}

export { monaco };
