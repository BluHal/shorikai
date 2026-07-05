// Thin LSP client: Monaco provider APIs wired straight to a language server
// over the lsp-host framed pipe. ponytail: no monaco-languageclient — it
// needs @codingame's patched monaco builds; these four features are plain
// protocol calls.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { monaco } from "./monacoSetup";
import { bus } from "./bus";
// monaco 0.55 exports the TS defaults from the contribution module
// (its .d.ts is `export {}`, so the runtime exports are reached via a cast)
import * as tsContrib from "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";

/* ---------- status store (status bar) ---------- */
export type LspState = "starting" | "running" | "crashed";
const states = new Map<string, LspState>();
const subs = new Set<() => void>();
export const getLspState = (root: string) => states.get(root);
export function subscribeLsp(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
function setState(root: string, s: LspState | undefined) {
  if (s) states.set(root, s);
  else states.delete(root);
  subs.forEach((fn) => fn());
}

/* ---------- position/type conversions ---------- */
type LspPos = { line: number; character: number };
type LspRange = { start: LspPos; end: LspPos };

const toLspPos = (p: monaco.Position): LspPos => ({
  line: p.lineNumber - 1,
  character: p.column - 1,
});
const toMonacoRange = (r: LspRange) =>
  new monaco.Range(
    r.start.line + 1,
    r.start.character + 1,
    r.end.line + 1,
    r.end.character + 1,
  );

const severityMap: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
};

// LSP CompletionItemKind (1-25) -> monaco CompletionItemKind
const kindMap: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text,
  2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function,
  4: monaco.languages.CompletionItemKind.Constructor,
  5: monaco.languages.CompletionItemKind.Field,
  6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class,
  8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Unit,
  12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet,
  16: monaco.languages.CompletionItemKind.Color,
  17: monaco.languages.CompletionItemKind.File,
  18: monaco.languages.CompletionItemKind.Reference,
  19: monaco.languages.CompletionItemKind.Folder,
  20: monaco.languages.CompletionItemKind.EnumMember,
  21: monaco.languages.CompletionItemKind.Constant,
  22: monaco.languages.CompletionItemKind.Struct,
  23: monaco.languages.CompletionItemKind.Event,
  24: monaco.languages.CompletionItemKind.Operator,
  25: monaco.languages.CompletionItemKind.TypeParameter,
};

const LSP_LANGS = new Set(["typescript", "javascript"]);

/* ---------- client ---------- */
class LspClient {
  root: string;
  serverId: number | null = null;
  ready = false;
  private nextReq = 1;
  private pending = new Map<number, (r: { result?: unknown; error?: { message?: string } }) => void>();
  private versions = new Map<string, number>();
  private attached = new Set<monaco.editor.ITextModel>();
  private syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private restarts = 0;

  constructor(root: string) {
    this.root = root;
  }

  async start() {
    setState(this.root, "starting");
    try {
      this.serverId = await invoke<number>("lsp_start", {
        command: "typescript-language-server",
        args: ["--stdio"],
        cwd: this.root,
      });
      byServer.set(this.serverId, this);
      const rootUri = `file://${this.root}`;
      const init = await this.request("initialize", {
        processId: null,
        rootUri,
        capabilities: {
          textDocument: {
            synchronization: {},
            publishDiagnostics: { relatedInformation: false },
            completion: {
              completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] },
            },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: {},
          },
          workspace: { configuration: true },
        },
        workspaceFolders: [{ uri: rootUri, name: this.root.split("/").pop() }],
      });
      if (init == null) throw new Error("initialize failed");
      this.notify("initialized", {});
      this.ready = true;
      this.restarts = 0;
      setState(this.root, "running");
      disableBuiltinTs();
      for (const model of this.attached) this.didOpen(model);
    } catch {
      setState(this.root, "crashed");
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextReq++;
    return new Promise((resolve) => {
      this.pending.set(id, (msg) => resolve(msg.error ? null : msg.result));
      this.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) resolve(null);
      }, 15000);
    });
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id: unknown, result: unknown) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private send(message: unknown) {
    if (this.serverId == null) return;
    invoke("lsp_send", { id: this.serverId, message }).catch(() => {});
  }

  attach(model: monaco.editor.ITextModel) {
    if (this.attached.has(model)) return;
    this.attached.add(model);
    if (this.ready) this.didOpen(model);
    model.onDidChangeContent(() => this.scheduleSync(model));
    model.onWillDispose(() => {
      this.attached.delete(model);
      const uri = model.uri.toString();
      if (this.versions.delete(uri)) {
        this.notify("textDocument/didClose", { textDocument: { uri } });
      }
    });
  }

  private didOpen(model: monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    if (this.versions.has(uri)) return;
    this.versions.set(uri, 1);
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: model.getLanguageId(),
        version: 1,
        text: model.getValue(),
      },
    });
  }

  private scheduleSync(model: monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    const timer = this.syncTimers.get(uri);
    if (timer) clearTimeout(timer);
    this.syncTimers.set(
      uri,
      setTimeout(() => this.syncNow(model), 250),
    );
  }

  /// flush pending edits; also called before position-based requests so the
  /// server never answers against a stale document
  syncNow(model: monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    const timer = this.syncTimers.get(uri);
    if (!timer) return;
    clearTimeout(timer);
    this.syncTimers.delete(uri);
    if (!this.versions.has(uri)) return;
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    // change event without range = full document replace (always valid)
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: model.getValue() }],
    });
  }

  handleMessage(msg: {
    id?: number | string;
    method?: string;
    params?: { uri?: string; diagnostics?: unknown[] };
    result?: unknown;
    error?: { message?: string };
  }) {
    if (msg.method == null && msg.id != null) {
      this.pending.get(msg.id as number)?.(msg);
      this.pending.delete(msg.id as number);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri) {
      publishMarkers(msg.params.uri, (msg.params.diagnostics ?? []) as LspDiagnostic[]);
      return;
    }
    if (msg.id != null) {
      // server-to-client request: answer benignly so it never hangs on us
      this.respond(msg.id, msg.method === "workspace/configuration" ? [{}] : null);
    }
  }

  handleExit() {
    if (this.serverId != null) byServer.delete(this.serverId);
    this.serverId = null;
    this.ready = false;
    this.versions.clear();
    this.syncTimers.forEach(clearTimeout);
    this.syncTimers.clear();
    if (clients.get(this.root) !== this) return; // stopped on purpose
    setState(this.root, "crashed");
    if (this.restarts < 3) {
      this.restarts += 1;
      setTimeout(() => {
        if (clients.get(this.root) === this) this.start();
      }, 1000 * this.restarts);
    }
  }

  stop() {
    const id = this.serverId;
    this.ready = false;
    if (id != null) {
      this.notify("shutdown", {});
      setTimeout(() => invoke("lsp_kill", { id }).catch(() => {}), 300);
      byServer.delete(id);
    }
    setState(this.root, undefined);
  }
}

type LspDiagnostic = {
  range: LspRange;
  message: string;
  severity?: number;
  code?: string | number;
  source?: string;
};

function publishMarkers(uri: string, diagnostics: LspDiagnostic[]) {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!model) return;
  monaco.editor.setModelMarkers(
    model,
    "lsp",
    diagnostics.map((d) => ({
      severity: severityMap[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
      message: d.message,
      code: d.code != null ? String(d.code) : undefined,
      source: d.source,
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
    })),
  );
}

/* ---------- registry + events ---------- */
const clients = new Map<string, LspClient>();
const byServer = new Map<number, LspClient>();
let wired = false;

function clientFor(model: monaco.editor.ITextModel): LspClient | undefined {
  const path = model.uri.path;
  let best: LspClient | undefined;
  for (const [root, client] of clients) {
    if (path.startsWith(root + "/") && (!best || root.length > best.root.length)) {
      best = client;
    }
  }
  return best?.ready ? best : undefined;
}

function wireOnce() {
  if (wired) return;
  wired = true;
  listen<{ kind: string; id: number; message?: never; code?: number | null } & { message?: object }>(
    "lsp:event",
    (e) => {
      const ev = e.payload as { kind: string; id: number; message?: object; code?: number | null };
      const client = byServer.get(ev.id);
      if (!client) return;
      if (ev.kind === "message" && ev.message) client.handleMessage(ev.message);
      else if (ev.kind === "exit") client.handleExit();
    },
  );
  registerProviders();
}

/* ---------- monaco providers ---------- */
function disableBuiltinTs() {
  const off = {
    completionItems: false,
    hovers: false,
    definitions: false,
    references: false,
    documentSymbols: false,
    diagnostics: false,
    documentHighlights: false,
    rename: false,
    signatureHelp: false,
    codeActions: false,
    inlayHints: false,
  };
  try {
    const contrib = tsContrib as unknown as {
      typescriptDefaults?: { setModeConfiguration(c: object): void };
      javascriptDefaults?: { setModeConfiguration(c: object): void };
    };
    contrib.typescriptDefaults?.setModeConfiguration(off);
    contrib.javascriptDefaults?.setModeConfiguration(off);
  } catch {
    // builtin stays on, harmless duplication
  }
}

type LspCompletionItem = {
  label: string | { label: string };
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  insertTextFormat?: number;
  filterText?: string;
  sortText?: string;
  textEdit?: { newText: string; range?: LspRange; insert?: LspRange };
};

function registerProviders() {
  const langs = [...LSP_LANGS];

  monaco.languages.registerCompletionItemProvider(langs, {
    triggerCharacters: [".", '"', "'", "/", "@", "<"],
    provideCompletionItems: async (model, position) => {
      const client = clientFor(model);
      if (!client) return { suggestions: [] };
      client.syncNow(model);
      const res = (await client.request("textDocument/completion", {
        textDocument: { uri: model.uri.toString() },
        position: toLspPos(position),
      })) as { items?: LspCompletionItem[] } | LspCompletionItem[] | null;
      const items = Array.isArray(res) ? res : (res?.items ?? []);
      const word = model.getWordUntilPosition(position);
      const defaultRange = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      return {
        suggestions: items.map((item) => {
          const label = typeof item.label === "string" ? item.label : item.label.label;
          const editRange = item.textEdit?.range ?? item.textEdit?.insert;
          return {
            label,
            kind: kindMap[item.kind ?? 1] ?? monaco.languages.CompletionItemKind.Text,
            detail: item.detail,
            documentation:
              typeof item.documentation === "string"
                ? item.documentation
                : item.documentation?.value,
            insertText: item.textEdit?.newText ?? item.insertText ?? label,
            insertTextRules:
              item.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            filterText: item.filterText,
            sortText: item.sortText,
            range: editRange ? toMonacoRange(editRange) : defaultRange,
          };
        }),
      };
    },
  });

  monaco.languages.registerHoverProvider(langs, {
    provideHover: async (model, position) => {
      const client = clientFor(model);
      if (!client) return null;
      client.syncNow(model);
      const res = (await client.request("textDocument/hover", {
        textDocument: { uri: model.uri.toString() },
        position: toLspPos(position),
      })) as { contents?: unknown; range?: LspRange } | null;
      if (!res?.contents) return null;
      const toMd = (c: unknown): string =>
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map(toMd).join("\n\n")
            : ((c as { value?: string })?.value ?? "");
      return {
        contents: [{ value: toMd(res.contents) }],
        range: res.range ? toMonacoRange(res.range) : undefined,
      };
    },
  });

  monaco.languages.registerDefinitionProvider(langs, {
    provideDefinition: async (model, position) => {
      const client = clientFor(model);
      if (!client) return null;
      client.syncNow(model);
      const res = (await client.request("textDocument/definition", {
        textDocument: { uri: model.uri.toString() },
        position: toLspPos(position),
      })) as
        | { uri?: string; range?: LspRange; targetUri?: string; targetRange?: LspRange }[]
        | { uri: string; range: LspRange }
        | null;
      const locs = res == null ? [] : Array.isArray(res) ? res : [res];
      return locs
        .map((l) => {
          const uri = "targetUri" in l && l.targetUri ? l.targetUri : (l as { uri?: string }).uri;
          const range =
            "targetRange" in l && l.targetRange ? l.targetRange : (l as { range?: LspRange }).range;
          if (!uri || !range) return null;
          return { uri: monaco.Uri.parse(uri), range: toMonacoRange(range) };
        })
        .filter((x): x is { uri: monaco.Uri; range: monaco.Range } => x != null);
    },
  });

  // cross-file go-to-definition lands in our own editor tabs
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      let line: number | undefined;
      if (selectionOrPosition) {
        line =
          "startLineNumber" in selectionOrPosition
            ? selectionOrPosition.startLineNumber
            : (selectionOrPosition as monaco.IPosition).lineNumber;
      }
      bus.openFile(resource.path, line);
      return true;
    },
  });
}

/* ---------- public api ---------- */
/// Called by the editor pane for every model it shows.
export function ensureLsp(root: string, model: monaco.editor.ITextModel) {
  if (!LSP_LANGS.has(model.getLanguageId())) return;
  wireOnce();
  let client = clients.get(root);
  if (!client) {
    client = new LspClient(root);
    clients.set(root, client);
    client.start();
  }
  client.attach(model);
}

/// Server lifecycle is tied to the workspace: called when a tab closes.
export function stopLsp(root: string) {
  const client = clients.get(root);
  if (!client) return;
  clients.delete(root);
  client.stop();
}
