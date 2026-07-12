# Git Cockpit Open Design and Safety Review

Status: **Approved by project owner on 2026-07-11**

This packet covers the explicit human/Open Design gates in GitHub issues #31,
#33, #40, #43, #44, and #45. It reviews the production implementation in
`src/panes/GitCockpitPane.tsx`, `src/chrome/GitOperationBanner.tsx`, and
`src-tauri/src/git_cockpit.rs` against the visual contract in
`git-cockpit-open-design-prompt.md`.

## Sign-off

| Review | Reviewer | Decision | Date | Notes |
| --- | --- | --- | --- | --- |
| Desktop and constrained-width history (#31) | Project owner | Approved | 2026-07-11 | Approved in Codex goal task. |
| Conflict list and three-way editor (#33) | Project owner | Approved | 2026-07-11 | Approved in Codex goal task. |
| Ordinary push preview (#40) | Project owner | Approved | 2026-07-11 | Approved in Codex goal task. |
| Linear rebase preflight and recovery (#43) | Project owner | Approved | 2026-07-11 | Approved in Codex goal task. |
| Interactive planner and result preview (#44) | Project owner | Approved | 2026-07-11 | Approved in Codex goal task. |
| Force-with-lease preview and confirmation (#45) | Project owner | Approved | 2026-07-11 | Approved in Codex goal task. |

Approval means the reviewer has exercised the states listed below in the native
desktop app and accepts both the interaction and the exact destructive language.

## #31 — History workspace

Review at desktop width and below 900 px:

- Git opens as one docked `Git` tab; local changes remain in Source Control.
- Desktop uses filter/ref rail, paginated commit graph, and inspector.
- The constrained layout moves the inspector below the graph without hiding
  filters, commit selection, file selection, or the Monaco Diff escape hatch.
- Parent count, merge commits, ref labels, page/filter continuation, commit
  metadata, and approximately 200 rows are legible at cockpit density.
- Selecting a file changes the inline preview; double-click opens Monaco Diff.

## #33 — Conflict resolver

Review text, delete/modify, add/add, binary, and externally created conflicts:

- The left list remains visible throughout resolution.
- Headers name the current branch and incoming side; Base is available on
  demand. Current and incoming are read-only and Result is editable.
- `Apply non-conflicting Git result`, `Accept current`, `Accept incoming`, and
  `Accept both` have visibly different consequences before `Save & Mark
  Resolved` stages the path.
- Binary conflicts expose only whole-file `Use current` and `Use incoming`.
- Resolving the last path enables Continue in the persistent operation banner;
  Abort remains reachable until Git reports completion.

## #40 — Ordinary push preview

Review ordinary, first-push, ambiguous-remote, authentication, rejected, and
detached-HEAD states:

- Heading names exact source and destination: `Push <local> → <remote>/<branch>`.
- Preview lists outgoing commits and affected files before network mutation.
- First push says `Creates <remote>/<branch> and sets it as upstream.`
- Authentication failure keeps `Open Terminal` and `Retry preview` visible.
- A rejection fetches refs and routes to comparison; it never offers automatic
  merge, rebase, or force.
- Ordinary push never displays the force-with-lease control.

## #43 — Linear rebase

Review clean, dirty/autostash, repeated conflict, Skip, Abort, restart, and
completion states:

- Comparison shows upstream, merge base, oldest/newest affected commit set,
  dirty-path count, and the tracked-branch push consequence.
- `Rebase` and `Rebase with autostash` are separate actions.
- The persistent banner reports `Rebase <current> of <total>`, current commit,
  autostash state, conflict count, Continue, Skip, and Abort.
- Reopening the app reconstructs the banner and resolver exclusively from Git
  metadata.
- Completion refreshes history; a rewritten tracked branch routes Push to the
  force-with-lease preview.

## #44 — Interactive rebase planner

Review reorder, Reword, Squash, Fixup, Drop, validation, conflict, and Abort:

- The selected base is explicit and affected commits are oldest first.
- Users manipulate structured rows, never a raw todo file.
- Reword and Squash show the resulting message before execution.
- Summary labels each original commit as `new identity`, `combines with
  previous`, or `disappears`.
- Squash/Fixup without a preceding non-dropped commit disables Start and shows
  an error.
- Execution uses native `git rebase -i` with internal sequence/message editors;
  no external editor appears. Rebase-merges, root, and update-refs are absent.

## #45 — Force-with-lease

Review only after a Shorikai rebase rewrites a tracked branch. Exact copy:

> Force-with-lease `<local>` to `<remote>/<branch>`?
> Expected fetched remote tip: `<full revision>`
> `<count>` remote commits will stop being reachable.

Required checks:

- Preview shows full old remote tip, full new local tip, outgoing replacements,
  and every remote commit removed from reachability.
- The control is named `Force with lease to <remote>/<branch>` and is visually
  distinct from ordinary Push.
- Remote-default or explicitly protected branches show only the policy block,
  unless `shorikai.allowForcePush.<remote>.<branch>=true` is configured.
- There is no unconditional force command or UI path.
- A stale lease refuses the push, fetches, and opens branch comparison.
- A successful lease refreshes upstream, history, and push state.

## Automated evidence

Run from the repository root:

```sh
npm run build
(cd src-tauri && cargo test --lib)
(cd src-tauri && cargo clippy --all-targets -- -D warnings)
```

Temporary-repository tests cover history pagination/filtering/exact hashes,
rename history and blame, branch tracking and worktrees, smart-stash recovery,
all comparison topologies, stash lifecycle/conflicts, text/delete/binary
conflicts, merge policy, multi cherry-pick recovery, reviewed/multiple revert,
linear and interactive rebase actions/recovery, destination resolution,
ordinary rejection reconciliation, and accepted/stale/protected leases.
