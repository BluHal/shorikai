# Shorikai — AI Agent Cockpit

> Terminal, editor, and multi-project agent crew in one window.

![Shorikai cockpit](design/project/screenshots/cockpit-v2.png)

Shorikai is a desktop IDE built for human-AI pair programming. It combines a full terminal emulator, a Monaco code editor with LSP support, and an AI agent communication layer into a single unified cockpit — giving you complete visibility into what your agents are doing across multiple projects.

Built with **Tauri 2 + Rust + React**.

## Features

- **Integrated Terminal** — Full PTY-backed terminal emulator (xterm.js + WebGL)
- **Code Editor** — Monaco editor with Language Server Protocol support (TypeScript, Go, Angular, and more)
- **AI Agent Chat** — Stream conversations with coding agents via the Agent Communication Protocol (ACP)
- **Claude Code + Codex Providers** — Switch agents from the chat pane; provider choice is remembered per project
- **Multi-Agent Crew** — Run and monitor multiple sub-agents with live status tracking
- **Multi-Project Workspaces** — Tab-based project switching with session persistence
- **Project Actions** — Save per-project shell commands with icons and optional keyboard shortcuts
- **Git Integration** — Stage, unstage, stage all, stash all, commit, and view diffs without leaving the cockpit
- **Debugging** — Full DAP support with breakpoints, step controls, call stack, variables, and console (Go via Delve, JavaScript via js-debug)
- **File Search** — Fuzzy file finder and ripgrep-powered content search
- **Previews** — Render Markdown, HTML, and images as ordinary panes
- **Status Bar** — Live cockpit vitals showing project and agent state

## Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- [Rust](https://www.rust-lang.org/tools/install) toolchain
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/)

## Getting Started

```bash
# Install frontend dependencies
npm install

# Run in development mode (Vite + Tauri)
npm run dev
```

## AI Agents

Open the AI chat pane and choose **Claude Code** or **Codex** from the provider control. Shorikai creates default ACP agent entries in `~/.config/shorikai/agents.json` and merges any missing defaults on startup, so custom edits in that file are preserved.

Codex runs with a Shorikai-scoped `CODEX_HOME`, which keeps global Codex MCP server settings from breaking the embedded chat session while still reusing your Codex auth files.

## Project Actions

Use the **Actions** chip in the active project tab to add project-scoped commands such as `npm run dev`, `npm test`, or custom scripts. Actions can have an icon and an optional shortcut, and they run in a project terminal.

Actions are saved in Shorikai session memory alongside project tabs and layouts.

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+T` | New terminal, or new AI chat tab when AI chat is focused |
| `Cmd+Shift+A` | Open/focus AI chat |
| `Cmd+Shift+J` | Open/focus terminal |
| `Cmd+J` | Toggle terminal panel |
| `Cmd+P` | Fuzzy file search |
| `Cmd+Shift+F` | Content search |
| `Cmd+\` | Collapse/restore editor dock |

The same AI chat and terminal commands are also available from the native **View** menu.

## Building

```bash
# Build the desktop application
npm run tauri build
```

The compiled binary will be available in `src-tauri/target/release/`.

## Project Structure

```
shorikai/
├── src/                   # React/TypeScript frontend
│   ├── chrome/            # Shell UI (titlebar, sidebar, status bar, panels)
│   ├── panes/             # Content panes (terminal, chat, editor, debug, preview)
│   ├── bus.ts             # Cross-pane event bus
│   ├── debug.ts           # DAP client
│   ├── lsp.ts             # LSP client
│   ├── gitStore.ts        # Git integration
│   └── projects.ts        # Workspace state management
├── src-tauri/             # Rust backend
│   └── src/
│       ├── pty_host.rs    # PTY session manager
│       ├── acp_bridge.rs  # Agent Communication Protocol bridge (JSON-RPC)
│       ├── lsp_host.rs    # LSP server process manager
│       ├── dap_core.rs    # Debug Adapter Protocol client
│       ├── git_status.rs  # Git operations
│       └── workspace_index.rs  # File indexing & search
└── design/                # Design assets and screenshots
```

## Configuration

| File | Purpose |
|------|---------|
| `~/.config/shorikai/lsp.json` | Language server configuration (auto-created with defaults) |
| `.shorikai/debug.json` | Per-project debug adapter configuration |
| `~/.config/shorikai/session.json` | Project tabs, layouts, and saved project actions |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | Tauri 2 (Rust) |
| Frontend | React 19, TypeScript 5.8, Vite 7 |
| Editor | Monaco Editor |
| Terminal | xterm.js 6 with WebGL rendering |
| Layout | dockview-react |
| Font | JetBrains Mono |

---

### Why "Shorikai"?

The name comes from [**Shorikai, Genesis Engine**](https://scryfall.com/card/sld/1880/shorikai-genesis-engine) — a legendary Vehicle artifact from *Magic: The Gathering* (Kamigawa: Neon Dynasty). Shorikai is a giant mech that draws cards and creates Pilot tokens to crew itself. It felt like the perfect metaphor: an AI-powered cockpit that bootstraps its own crew of agents to get the job done. Plus, it's a mech. Who doesn't want to work inside a mech?
