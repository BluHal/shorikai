// Tiny cross-pane bus: App wires the real implementations once dockview is
// ready; panes call them without threading the dockview api around.
export const bus = {
  openFile: (_path: string, _line?: number) => {},
  openDiff: (_path: string, _oldText: string, _newText: string) => {},
  openChat: () => {},
  openTerminal: () => {},
  collapseEditor: () => {},
  toggleTerminal: () => {},
  openSearch: (_mode: "files" | "content") => {},
  startDebugTerminal: () => {},
  startGoDebug: () => {},
  openCliTerminal: (_cmd: string, _title: string) => {},
  openGit: (_section?: string, _target?: string) => {},
};
