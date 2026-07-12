// Shared git status store, keyed by project root: one refresher, many
// subscribers (git panel, badge, tree coloring, titlebar branch). Refreshes
// on watcher events plus a slow safety interval so index changes made in a
// terminal still show up.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type GitFile = {
  path: string;
  staged: string | null;
  unstaged: string | null;
  orig_path: string | null;
};

export type GitStatus = {
  branch: string;
  head: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  conflicts: number;
  remotes: string[];
  default_branch: string | null;
  worktrees: GitWorktree[];
  operation: GitOperation | null;
  files: GitFile[];
};

export type GitWorktree = {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
};

export type GitOperation = {
  kind: "merge" | "cherry_pick" | "revert" | "rebase" | "bisect" | "detached_head";
  label: string;
  title: string;
  message: string;
  can_continue: boolean;
  can_abort: boolean;
  can_skip: boolean;
  conflicts: number;
  progress_current: number | null;
  progress_total: number | null;
  current_commit: string | null;
};

const states = new Map<string, GitStatus | null>();
const roots = new Set<string>();
const subs = new Set<() => void>();

export const getGitFor = (root: string) => states.get(root) ?? null;

export function subscribeGit(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/// register a project root for status tracking (idempotent)
export function trackGitRoot(root: string) {
  if (roots.has(root)) return;
  roots.add(root);
  refreshGit(root);
}

export function untrackGitRoot(root: string) {
  roots.delete(root);
  states.delete(root);
  subs.forEach((fn) => fn());
}

export async function refreshGit(root?: string) {
  const targets = root ? [root] : [...roots];
  await Promise.all(
    targets.map(async (r) => {
      try {
        states.set(r, await invoke<GitStatus>("git_status_cmd", { root: r }));
      } catch {
        states.set(r, null); // not a git repo, or git missing
      }
    }),
  );
  subs.forEach((fn) => fn());
}

let started = false;
export function startGitStore() {
  if (started) return;
  started = true;
  listen("ws:changed", () => refreshGit());
  setInterval(() => refreshGit(), 5000);
}
