import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./app";
import { resolveWorkspace } from "./workspace";

const LAST_WORKSPACE_KEY = "lastWorkspace";

// localStorage throws when storage is blocked; the app still works without it
function readLastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

function saveLastWorkspace(id: string) {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, id);
  } catch {
    // Not remembered; the URL still has the workspace
  }
}

const workspace = resolveWorkspace(location.pathname, readLastWorkspace(), () =>
  crypto.randomUUID()
);

if (workspace.kind === "open") {
  // Show the canonical link: new or reopened workspace, lowercased ID
  if (location.pathname !== workspace.path) {
    history.replaceState(null, "", workspace.path);
  }
  saveLastWorkspace(workspace.id);
}

const root = createRoot(document.getElementById("root")!);
root.render(<App workspace={workspace} />);
