import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IDockviewPanelProps } from "dockview-react";
import { useProjectRoot } from "../projects";
import "@xterm/xterm/css/xterm.css";

type TerminalParams = {
  /// extra env vars (debug terminals inject the js-debug bootloader here)
  env?: Record<string, string>;
  /// reverse-request handle to answer once the shell is up
  dapReply?: { sessionId: number; requestSeq: number };
};

export function TerminalPane(props: IDockviewPanelProps<TerminalParams>) {
  const ref = useRef<HTMLDivElement>(null);
  const root = useProjectRoot();

  useEffect(() => {
    const el = ref.current!;
    const css = getComputedStyle(document.documentElement);
    const tok = (name: string) => css.getPropertyValue(name).trim();
    const term = new Terminal({
      fontFamily: tok("--font-mono"),
      fontSize: 12.5,
      lineHeight: 1.44, /* 18px over 12.5px, per the design's terminal block */
      cursorBlink: true,
      theme: {
        background: tok("--surface-1"),
        foreground: tok("--text-2"),
        cursor: tok("--text-2"),
        selectionBackground: "rgba(63, 190, 203, 0.26)",
        black: tok("--titlebar"),
        red: tok("--error"),
        green: tok("--git-added"),
        yellow: tok("--warning"),
        blue: tok("--syn-type"),
        magenta: tok("--syn-keyword"),
        cyan: tok("--accent"),
        white: tok("--text-1"),
        brightBlack: tok("--text-4"),
        brightRed: tok("--error"),
        brightGreen: tok("--success"),
        brightYellow: tok("--syn-func"),
        brightBlue: tok("--accent-dim"),
        brightMagenta: tok("--syn-num"),
        brightCyan: tok("--accent-bright"),
        brightWhite: tok("--text-1"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (e) {
      console.warn("WebGL renderer unavailable, using canvas fallback", e);
    }
    fit.fit();

    let ptyId: number | null = null;
    let disposed = false;

    const unData = listen<{ id: number; data: string }>("pty:data", (e) => {
      if (e.payload.id === ptyId) term.write(e.payload.data);
    });
    const unExit = listen<{ id: number }>("pty:exit", (e) => {
      if (e.payload.id === ptyId) props.api.close();
    });

    invoke<[number, number | null]>("pty_spawn", {
      cols: term.cols,
      rows: term.rows,
      cwd: root,
      env: props.params?.env,
    }).then(
      ([id, pid]) => {
        if (disposed) {
          invoke("pty_kill", { id }).catch(() => {});
          return;
        }
        ptyId = id;
        const reply = props.params?.dapReply;
        if (reply) {
          invoke("dap_reply_run_in_terminal", {
            sessionId: reply.sessionId,
            requestSeq: reply.requestSeq,
            shellPid: pid,
          }).catch(() => {});
        }
      },
      (err) => term.write(`\r\nfailed to spawn shell: ${err}\r\n`),
    );

    term.onData((data) => {
      if (ptyId != null) invoke("pty_write", { id: ptyId, data });
    });
    term.onResize(({ cols, rows }) => {
      if (ptyId != null) invoke("pty_resize", { id: ptyId, cols, rows });
    });
    term.onTitleChange((title) => props.api.setTitle(title));

    const activeSub = props.api.onDidActiveChange(({ isActive }) => {
      if (isActive) term.focus();
    });
    if (props.api.isActive) term.focus();

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);

    return () => {
      disposed = true;
      observer.disconnect();
      activeSub.dispose();
      unData.then((u) => u());
      unExit.then((u) => u());
      if (ptyId != null) invoke("pty_kill", { id: ptyId }).catch(() => {});
      term.dispose();
    };
  }, []);

  return <div ref={ref} className="terminal-pane" />;
}
