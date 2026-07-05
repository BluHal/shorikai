// Tiny cross-pane bus: App wires the real implementations once dockview is
// ready; panes call them without threading the dockview api around.
export const bus = {
  openFile: (_path: string) => {},
};
