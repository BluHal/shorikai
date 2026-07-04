export function Titlebar() {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-tabs">
        <div className="project-tab project-tab-active">
          <span className="dot dot-idle" />
          <span>shorikai</span>
        </div>
        <div className="project-tab-new" title="New project">
          +
        </div>
      </div>
    </div>
  );
}
