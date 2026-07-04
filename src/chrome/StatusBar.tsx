const BranchIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="8" r="2.4" />
    <path d="M6 8.4v7.2M8.4 6H14a3 3 0 0 1 3 3" />
  </svg>
);

// Skeleton: live vitals (branch, LSP, agent state, cursor, ports) are issue #20.
export function StatusBar() {
  return (
    <div className="statusbar">
      <div className="statusbar-seg statusbar-branch">
        {BranchIcon}
        <span>—</span>
      </div>
      <div className="statusbar-right">
        <span className="statusbar-seg">Ln —, Col —</span>
        <span className="statusbar-seg">UTF-8</span>
      </div>
    </div>
  );
}
