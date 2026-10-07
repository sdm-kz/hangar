import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

// One page, three windows: the URL hash says which (see windows.rs).
const Overlay = lazy(() => import("./overlay/Overlay"));
const Editor = lazy(() => import("./editor/Editor"));
const Settings = lazy(() => import("./settings/Settings"));

function Route() {
  const [view, arg] = location.hash.replace(/^#/, "").split("/");
  switch (view) {
    case "overlay":
      return <Overlay frame={Number(arg)} />;
    case "editor":
      return <Editor id={arg} />;
    default:
      return <Settings />;
  }
}

// No browser context menu or reload shortcuts: this is an app, not a page.
window.addEventListener("contextmenu", (e) => {
  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Route />
    </Suspense>
  </StrictMode>,
);
