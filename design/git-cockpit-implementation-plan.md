# Shorikai Git Cockpit implementation plan

This plan maps the Open Design export at project `e3b036ee-12fa-4e6d-bd8e-20de73afd7fa`
onto Shorikai's production React, Dockview, Tauri, and Git CLI architecture. Git
workflows are docked panels, not browser routes.

## Production map

| Open Design surface | Production UI | Production state/backend |
| --- | --- | --- |
| Source Control | Existing `chrome/GitPanel.tsx` in the 260px utility sidebar | Extend `gitStore.ts`; keep file staging and commit here |
| Branch popup | `chrome/GitBranchMenu.tsx`, opened from the project tab branch control | New ref/upstream/fetch/checkout commands in `git_status.rs` |
| History | `panes/GitHistoryPane.tsx`, Dockview component `git-history` | Paged `git log` command with filters and parent topology |
| Compare | `panes/GitComparePane.tsx`, Dockview component `git-compare` | Ahead/behind, commit ranges, changed files, and patch commands |
| Operation banner | `chrome/GitOperationBanner.tsx`, persistent above Dockview | Repository-state detection and continue/abort commands |
| Operations | `panes/GitOperationsPane.tsx`, Dockview component `git-operations` | Current operation plus recent in-session Git action results |
| Merge | `panes/GitMergePane.tsx`, Dockview component `git-merge` | Preflight, true merge, pause-before-commit, continue/abort |
| Conflicts | `panes/GitConflictPane.tsx`, Dockview component `git-conflicts` | Index stages 1/2/3, resolution writes, mark-resolved command |
| Push preview | `panes/GitPushPane.tsx`, Dockview component `git-push` | Upstream preview and normal push; create missing branch on push |
| Stashes | `panes/GitStashPane.tsx`, Dockview component `git-stashes` | List/create/apply/pop/drop with untracked-file support |
| File history/blame | `panes/GitFileHistoryPane.tsx`, Dockview component `git-file-history` | File-scoped log and blame commands; editor entry points |
| Safe deletion/undo | Confirmation in Branch/Compare surfaces | Merged/unmerged preflight plus session-scoped undo record |

All Dockview surfaces are opened through `bus.ts` and registered by
`Workspace.tsx`. The shell remains unchanged: 40px project top bar, 260px left
utility sidebar, docked workspace, and 24px status bar.

## Delivery order

1. Repository state and operation banner (#29): expose HEAD, detached state,
   upstream, remotes, default branch, worktrees, conflicts, and external Git
   operations. Support continue/abort only for merge, cherry-pick, and revert.
2. Branch popup and tracking checkout (#28): local/recent/remote sections,
   explicit fetch state, and collision handoff to Compare.
3. History and Compare (#30, #31, #36): build the read-only investigation path
   before adding destructive actions.
4. Merge and operation flow (#32): preflight, true merge, and pause before commit.
5. Conflict resolution (#33, #39): 3-way text resolution and explicit binary
   handling.
6. Push, stash, deletion, and undo (#40, #41, #42, #35): add guarded write
   workflows on top of the shared repository model.
7. File history and blame (#34): connect editor context to repository history.

Each increment must add focused Rust tests for parsing/state transitions and pass
the frontend production build before the next surface starts.

## Interaction contract

- Opening the branch popup never fetches.
- Remote checkout creates a tracking local branch; a local-name collision opens
  Compare.
- Supported in-progress operations remain visible in a narrow, nonmodal banner
  until Git reports completion.
- Rebase and bisect started outside Shorikai are detected but handled in Terminal.
- Dangerous confirmations preserve the exact copy and scope boundaries from
  `inventory.html`.
- Local changes and staging stay in Source Control; repository-wide investigation
  and operations stay in docked workspace tabs.

## Explicit exclusions

Do not add force push, remote branch deletion, starting rebase, hunk staging,
partial cherry-pick/revert, PR/CI integration, multi-repository sync, worktree
management, or advanced merge strategy controls.
