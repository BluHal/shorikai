import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "./tokens.css";

// No StrictMode: its double-mounted effects spawn and kill a throwaway PTY
// per terminal pane in dev.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
