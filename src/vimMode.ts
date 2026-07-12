import { useSyncExternalStore } from "react";

const STORAGE_KEY = "shorikai.vimMode";
const listeners = new Set<() => void>();

export function getVimMode() {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function subscribeVimMode(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setVimMode(enabled: boolean) {
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  listeners.forEach((fn) => fn());
}

export function useVimMode() {
  return useSyncExternalStore(subscribeVimMode, getVimMode);
}
