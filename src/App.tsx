import { DockviewReact, DockviewReadyEvent } from "dockview-react";
import { Titlebar } from "./chrome/Titlebar";
import { Sidebar } from "./chrome/Sidebar";
import { StatusBar } from "./chrome/StatusBar";
import { TerminalPane } from "./panes/TerminalPane";
import "dockview-react/dist/styles/dockview.css";
import "./App.css";

const components = {
  terminal: TerminalPane,
};

function App() {
  const onReady = (event: DockviewReadyEvent) => {
    event.api.addPanel({
      id: "terminal-1",
      component: "terminal",
      title: "zsh",
    });
  };

  return (
    <>
      <Titlebar />
      <div className="app-body">
        <Sidebar />
        <DockviewReact
          className="dockview-theme-dark app-dock"
          components={components}
          onReady={onReady}
        />
      </div>
      <StatusBar />
    </>
  );
}

export default App;
