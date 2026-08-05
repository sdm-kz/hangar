import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { PreviewApp } from "./components/PreviewApp";
import { ConfirmProvider } from "./components/ui/confirm";
import { readPreviewPath } from "./lib/urlState";
import { registerServiceWorker } from "./lib/push";

// Register the push service worker (no-op where unsupported). Must happen before the user can
// subscribe; safe to run on every load — the browser reuses the existing registration.
registerServiceWorker();

// `?preview=<path>` marks a standalone file-preview tab: mount just the viewer instead of the full
// app so the tab doesn't drag in the sidebar, session stream, and polling. Decided once at load —
// nothing navigates between the two modes within a tab.
const previewPath = readPreviewPath();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfirmProvider>
      {previewPath ? <PreviewApp path={previewPath} /> : <App />}
    </ConfirmProvider>
  </StrictMode>
);
