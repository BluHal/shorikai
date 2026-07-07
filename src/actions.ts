const ALIASES: Record<string, string> = {
  cmd: "meta",
  command: "meta",
  ctrl: "control",
  ctl: "control",
  option: "alt",
  opt: "alt",
};

const ORDER = ["meta", "control", "alt", "shift"];

export function normalizeShortcut(raw = "") {
  const parts = raw
    .toLowerCase()
    .replace(/\s+/g, "")
    .split("+")
    .filter(Boolean)
    .map((p) => ALIASES[p] ?? p);
  const key = parts.find((p) => !ORDER.includes(p));
  if (!key) return "";
  return [...ORDER.filter((p) => parts.includes(p)), key].join("+");
}

export function eventShortcut(e: KeyboardEvent) {
  const key = e.code.startsWith("Key")
    ? e.code.slice(3).toLowerCase()
    : e.code.startsWith("Digit")
      ? e.code.slice(5)
      : e.code.toLowerCase();
  return normalizeShortcut(
    [
      e.metaKey && "meta",
      e.ctrlKey && "control",
      e.altKey && "alt",
      e.shiftKey && "shift",
      key,
    ].filter(Boolean).join("+"),
  );
}

export function hasShortcutModifier(shortcut: string) {
  return ["meta+", "control+", "alt+"].some((prefix) => shortcut.startsWith(prefix));
}
