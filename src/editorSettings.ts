import { useSyncExternalStore } from "react";

const RELATIVE_LINES_KEY = "shorikai.relativeLineNumbers";
const listeners = new Set<() => void>();

export function getRelativeLineNumbers() {
  return localStorage.getItem(RELATIVE_LINES_KEY) !== "0";
}

export function subscribeEditorSettings(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setRelativeLineNumbers(enabled: boolean) {
  localStorage.setItem(RELATIVE_LINES_KEY, enabled ? "1" : "0");
  listeners.forEach((fn) => fn());
}

export function useRelativeLineNumbers() {
  return useSyncExternalStore(subscribeEditorSettings, getRelativeLineNumbers);
}
