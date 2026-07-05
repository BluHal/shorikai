// Shared git status store: one refresher, many subscribers (git panel badge,
// tree coloring). Refreshes on watcher events plus a slow safety interval so
// index changes made in a terminal still show up.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type GitFile = {
  path: string;
  staged: string | null;
  unstaged: string | null;
  orig_path: string | null;
};

export type GitStatus = { branch: string; files: GitFile[] };

let state: GitStatus | null = null;
let root: string | null = null;
const subs = new Set<() => void>();

export const getGit = () => state;
export const getGitRoot = () => root;

export function subscribeGit(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export async function refreshGit() {
  if (!root) return;
  try {
    state = await invoke<GitStatus>("git_status_cmd", { root });
  } catch {
    state = null; // not a git repo, or git missing
  }
  subs.forEach((fn) => fn());
}

let started = false;
export async function startGitStore() {
  if (started) return;
  started = true;
  root = await invoke<string>("project_root");
  await refreshGit();
  listen("ws:changed", () => refreshGit());
  setInterval(refreshGit, 5000);
}
