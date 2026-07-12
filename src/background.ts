import { useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

const STORAGE_KEY = "shorikai.ideBackground";

type IdeBackground = {
  path: string;
  opacity: number;
};

const fallback: IdeBackground = { path: "", opacity: 0.18 };
const listeners = new Set<() => void>();

function read(): IdeBackground {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function write(next: IdeBackground) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  listeners.forEach((fn) => fn());
}

export function getIdeBackground() {
  return read();
}

export function subscribeIdeBackground(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setBackgroundImage(path: string) {
  write({ ...read(), path });
}

export function setBackgroundOpacity(opacity: number) {
  write({ ...read(), opacity: Math.min(1, Math.max(0, opacity)) });
}

export function clearBackgroundImage() {
  write({ ...read(), path: "" });
}

export function backgroundUrl(path: string) {
  return path ? convertFileSrc(path) : "";
}

export function useIdeBackground() {
  return useSyncExternalStore(subscribeIdeBackground, getIdeBackground);
}
