// Live cockpit vitals for the status bar: cursor position of the focused
// editor and dev-server ports sniffed from terminal output.

export type Cursor = { line: number; col: number; lang: string | null };

type Vitals = {
  cursor: Cursor | null;
  /// root -> detected dev-server port (with owning pty for cleanup)
  ports: Map<string, { port: number; ptyId: number }>;
};

let snapshot: Vitals = { cursor: null, ports: new Map() };
const subs = new Set<() => void>();
const emit = () => subs.forEach((fn) => fn());

export const getVitals = () => snapshot;
export function subscribeVitals(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function setCursor(cursor: Cursor) {
  const prev = snapshot.cursor;
  if (
    prev &&
    prev.line === cursor.line &&
    prev.col === cursor.col &&
    prev.lang === cursor.lang
  ) {
    return;
  }
  snapshot = { ...snapshot, cursor };
  emit();
}

const PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/;

/// scan a terminal chunk for a dev-server URL; returns carry-over tail so
/// matches split across chunks still hit
export function sniffPort(
  root: string,
  ptyId: number,
  chunk: string,
  carry: string,
): string {
  const text = carry + chunk;
  const m = PORT_RE.exec(text);
  if (m) {
    const port = Number(m[1]);
    if (port >= 80) {
      const cur = snapshot.ports.get(root);
      if (!cur || cur.port !== port || cur.ptyId !== ptyId) {
        const ports = new Map(snapshot.ports);
        ports.set(root, { port, ptyId });
        snapshot = { ...snapshot, ports };
        emit();
      }
    }
  }
  return text.slice(-160);
}

export function clearPortForPty(ptyId: number) {
  let changed = false;
  const ports = new Map(snapshot.ports);
  for (const [root, entry] of ports) {
    if (entry.ptyId === ptyId) {
      ports.delete(root);
      changed = true;
    }
  }
  if (changed) {
    snapshot = { ...snapshot, ports };
    emit();
  }
}
