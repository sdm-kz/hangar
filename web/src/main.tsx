import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ConfirmProvider } from "./components/ui/confirm";
import { registerServiceWorker } from "./lib/push";

// Register the push service worker (no-op where unsupported). Must happen before the user can
// subscribe; safe to run on every load — the browser reuses the existing registration.
registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </StrictMode>
);
