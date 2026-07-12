# Open Design Prompt: Shorikai Git Cockpit

Design a high-fidelity, interactive expansion of the Git experience inside **Shorikai**, an existing desktop IDE for human-AI pair programming. This is a product-tool design task, not a landing page and not a visual rebrand.

## Reference Material

Use the attached current cockpit design as the visual baseline:

- `design/project/screenshots/cockpit-v2.png`
- `design/project/Cockpit.dc.html`
- `src/tokens.css`

![Current cockpit visual reference](project/screenshots/cockpit-v2.png)

The screenshot and HTML are an earlier prototype that still displays the historical name **HELM**. The current product name is **SHORIKAI**. Preserve the shell, density, palette, proportions, and interaction character, but use the current Shorikai name.

The current production UI has evolved from that prototype and keeps the same design language:

- A 40px macOS-style top project bar with project tabs, active-project cyan edge, project status, current branch, and compact project actions.
- A fixed 260px left utility sidebar with the SHORIKAI wordmark and a segmented `Files / Search / Git` switch.
- A dockable main workspace containing chat, editors, diffs, previews, debug tools, and terminals as ordinary tabs and split panes.
- A compact 24px bottom status bar with branch, ahead/behind counts, working-tree counts, LSP state, agent state, cursor position, encoding, language, and running port.
- The existing Git sidebar contains staged files, unstaged changes, per-file stage/unstage controls, stash, commit message, Commit, and Push.

Do not redesign these foundations. Extend them coherently.

## Current Visual System

Shorikai is a quiet, dense, operational cockpit. It should feel built for repeated daily use, not like a dashboard template.

Use these visual rules:

- JetBrains Mono throughout.
- Near-black charcoal base: `#101216`.
- Darker title and status bars: `#0c0e12`.
- Layered surfaces: `#15171c`, `#191c22`, `#20242b`, `#272c34`.
- Subtle separators: `#22262e`, stronger only when necessary: `#30353e`.
- Primary text `#d7dae0`; secondary `#9aa0ab`; muted `#6b7079`; faint `#464b54`.
- Cyan/teal is the single interaction accent: `#3fbecb`, brighter `#5cd4df`, dim `#2c8a95`.
- Git added/success green: `#57c98a`; modified/warning amber: `#d0a54f`; deleted/error red: `#df6a61`.
- Diff backgrounds remain low-opacity green and red, never saturated blocks.
- Most text is 10-13px. Reserve 14-17px for prominent pane titles or input content only.
- Rows and controls are generally 24-30px tall.
- Use 4px, 6px, or at most 8px radii. Avoid pills except compact counts or status indicators.
- Use 1px borders, restrained hover fills, and cyan edges for active focus.
- Use familiar Lucide icons with tooltips. Prefer icon buttons for fetch, refresh, filter, compare, close, abort, continue, search, and overflow actions.
- Keep body and control letter spacing at 0.
- No gradients, decorative glows, oversized headings, floating page sections, nested cards, marketing copy, or ornamental illustrations.
- Do not place the primary Git experience in a decorative card. It is a full working surface.

## Product Goal

Make branch divergence, history, merge, conflict resolution, push, and stash workflows dramatically easier to understand than the terminal while keeping Git semantics visible and trustworthy.

The design must feel like Shorikai, but the information architecture should learn from IntelliJ IDEA:

- Current branch and fetch are immediately available from the top project bar.
- Local work remains in the existing left Source Control sidebar.
- Repository history and branch comparison use the full editor dock.
- Commit, branch, file, and operation actions appear in the context where they make sense.
- Dangerous actions explain impact before execution.
- The terminal remains the escape hatch for unsupported operations.

## Required Surfaces

### 1. Branch Widget And Browser

Make the current branch label in the active project tab an interactive branch widget.

Design a compact popup that includes:

- Searchable Local Branches and Remote Branches groups.
- Current branch, upstream, ahead/behind counts, and remote name.
- Indicators for the remote default branch, protected branch, and branches occupied by linked worktrees.
- Recent branches near the top without duplicating them confusingly.
- A Fetch icon in the popup header with idle, running spinner, success, and error states.
- A tooltip or secondary label for `Last fetched 4 min ago`.
- Explicit actions for New Branch, Checkout, Compare with Current, Merge into Current, Rename, and Delete when valid.
- Opening the popup must not imply an automatic fetch.
- Checking out a remote-only branch creates a same-named local tracking branch.
- A local-name collision opens comparison instead of silently resetting anything.
- Detached HEAD is never entered accidentally.

Show the popup in normal, fetching, authentication-error, and operation-in-progress states.

### 2. Full Git History Workspace

Design a docked `Git` tab in the main workspace. Do not squeeze the commit graph into the 260px sidebar.

Use this functional layout:

- Left: compact, collapsible branch/ref rail.
- Center: paginated commit DAG and commit list.
- Right: inspector containing commit details, changed files, and diff preview.

The history workspace must show:

- Parent edges, merge commits, HEAD, local branches, remote branches, and tags.
- Commit subject, author, relative or exact date, and abbreviated hash.
- Clear selected row, current-branch emphasis, and restrained graph colors that do not compete with semantic Git colors.
- Approximately 200 commits initially, with a calm load-more or infinite-pagination state.
- Filters for refs, message or hash, author, commit date, and file/path.
- Active filters as compact removable controls plus one clear-all icon.
- Exact hash/branch/tag navigation.
- Missing parents at a filtered or pagination boundary shown as continuation edges, never connected to the wrong commit.
- Changed-file status, path, rename origin, and additions/deletions when available.
- Selecting a file updates the inspector diff; double-click opens the existing full Monaco diff tab.

Design default, loading, filtered, no-results, selected merge commit, and truncated-history states.

### 3. Branch Comparison

Create a dedicated comparison tab opened from the branch popup, history refs, deletion warnings, rejected push, and merge preflight.

It must show:

- Actual branch names, never ambiguous `ours` and `theirs` labels.
- The merge base.
- Commits unique to the current branch.
- Commits unique to the selected branch.
- Ahead/behind counts.
- Net changed files between branch tips with diff preview.
- Explicit states for identical, already contained, fast-forward possible, behind-only, and divergent histories.
- Contextual actions: Checkout, Create Branch, Merge into Current, and Delete when valid.

The user should understand the topology before acting without knowing Git range syntax.

### 4. Persistent Git Operation Banner

Design a narrow persistent operation surface that appears when Git reports:

- Merge in progress.
- Cherry-pick in progress.
- Revert in progress.
- Rebase in progress.
- Bisect in progress.
- Detached HEAD.

Supported operations expose clear Continue and Abort actions. Operations not initiated or fully supported by Shorikai, including rebase in this milestone, show exact state plus an Open Terminal action.

The banner must be noticeable without covering editor content or becoming a modal.

### 5. Three-Way Conflict Resolver

Design an in-app merge editor that fits naturally beside Monaco-based editors.

Required behavior:

- Read-only current-branch pane.
- Editable result pane in the center.
- Read-only incoming-branch pane.
- Branch names in headers instead of only `ours` and `theirs`.
- Optional base-revision access without forcing a permanent fourth pane.
- Conflict list and progress count across files.
- Per-conflict Accept Current, Accept Incoming, Accept Both, and Ignore/undo controls.
- Apply non-conflicting changes action.
- Manual editing in the result.
- Save and Mark Resolved.
- Previous/next conflict navigation.
- Abort parent operation remains reachable.
- Binary conflicts use a simple whole-file `Use Current` or `Use Incoming` decision with metadata preview.

Show unresolved, partially resolved, fully resolved, delete/modify, add/add, binary, and autostash-restoration conflict states.

### 6. Reviewable Merge Flow

Design merge as a staged, understandable workflow.

Preflight must distinguish:

- Already merged: no action required.
- Fast-forward: show incoming commits and files; completes directly after confirmation.
- True merge: show both sides and explain that a merge commit will be created.
- Unrelated histories: blocked with terminal escape hatch.

A true merge pauses before the merge commit and presents:

- Staged merge result.
- Proposed merge message.
- Complete Merge.
- Abort.
- Conflict-resolution entry point when needed.
- Autostash state and a separate warning if restoring local work causes conflicts after the merge.

Keep the language concise and concrete. Prefer `Merge feature/login into main` over generic confirmation copy.

### 7. Push Preview

Replace the current immediate Push action with a compact IntelliJ-style preview.

Show:

- Local source branch.
- Remote and destination branch.
- Outgoing commits.
- Affected files and optional diff inspection.
- Ahead count.
- Authentication/progress state.
- A clear note when the remote branch does not exist: `Creates origin/feature/login and sets it as upstream`.

If push is rejected, fetch and route the user to branch comparison. Do not propose automatic merge, automatic rebase, or force push in this milestone.

Design ordinary push, first push creating a remote branch, ambiguous remote selection, authentication failure, rejected push, and success states.

### 8. Stash Manager

Extend the current Source Control area with a complete stash workflow:

- Create named stash.
- Include untracked toggle.
- Stash list with source branch, message, age, and file count.
- Changed files and diff preview.
- Apply, Pop, and confirmed Drop.
- Clear distinction between user-created stashes and a Shorikai smart-checkout stash that failed to restore.

Do not hide a failed smart stash. Make recovery obvious.

### 9. Safe Branch Deletion

Design two deletion paths.

For a fully merged local branch:

- Concise confirmation or direct safe deletion.
- Success notification with session-level Undo.

For an unmerged branch:

- Show commits unique to the branch.
- Show whether another ref contains the tip.
- Make Compare the primary action.
- Keep Delete Anyway visually destructive and behind explicit confirmation.

Protect the current branch, branches occupied by worktrees, and the remote's declared default branch. Do not guess protection from names such as `main` or `master`. Remote branch deletion is out of scope.

Undo restores branch name, tip, and upstream when possible. If the name has been reused, offer an alternate restore name rather than overwriting it.

### 10. File History And Blame

Design:

- A dedicated file-history tab that follows renames and exposes prior paths.
- An on-demand editor blame gutter showing author, age, and abbreviated commit.
- Hover details with commit subject and exact timestamp.
- Clicking an annotation opens the responsible commit in Git history.

Blame is off by default. Do not add always-visible author decorations throughout the editor.

### 11. Cherry-Pick And Revert

Match IntelliJ semantics:

- Whole-commit cherry-pick previews the commit, then applies and commits automatically.
- Conflicts pause with Continue and Abort in the persistent operation surface.
- Revert opens commit review with an automatically generated message, allows complete files to be excluded, and commits only after explicit confirmation.
- Reverting multiple commits creates separate revert commits.

Do not design hunk-level partial cherry-pick or revert in this milestone.

## Responsive Behavior

Design at minimum:

- Primary desktop: 1440x900 or 1600x1000.
- Constrained desktop: approximately 1024x700.

At constrained widths:

- Preserve the 260px app sidebar when practical.
- Allow the Git branch rail to collapse to an icon rail or menu.
- Convert the right inspector into `Details / Files / Diff` tabs when three columns no longer fit.
- Keep the commit graph readable and horizontally stable.
- Never allow labels, hashes, branch names, buttons, or status text to overlap.
- Use ellipsis with full-value tooltips for long refs and paths.

## Scope Boundaries

Do not design these as available actions in this milestone:

- Starting linear or interactive rebase.
- Force push or force-with-lease.
- Remote branch deletion.
- Hunk or line staging.
- Partial cherry-pick or partial revert.
- Multi-repository synchronized operations.
- A worktree creation/deletion manager.
- Squash merge, unrelated-history merge, or manual no-fast-forward overrides.
- Git hosting pull-request or CI integrations.

The UI may detect an externally started rebase and hand it off to the terminal, but it must not pretend to manage the full workflow yet.

## Deliverables

Produce one coherent interactive design project containing:

1. The current Shorikai cockpit extended with the branch widget and Fetch states.
2. The default Git history workspace.
3. Filtered history and exact-hash navigation.
4. Branch comparison across all topology states.
5. Merge preflight and true-merge review.
6. Three-way text and binary conflict resolution.
7. Push preview and rejected-push recovery.
8. Stash management.
9. Safe branch deletion and Undo.
10. File history and blame.
11. Operation banners for merge, cherry-pick, revert, external rebase, bisect, and detached HEAD.
12. Primary and constrained desktop layouts.

Include interaction paths between these surfaces, hover/focus/disabled/loading/error states, exact user-facing copy, and a compact component/state inventory for implementation handoff.

The result should look like these Git capabilities have always belonged in Shorikai.
