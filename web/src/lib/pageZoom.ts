// In the installed app, a trackpad pinch or Ctrl+wheel zooms the whole window — sidebar,
// toolbars and all — which an app never does, and is easy to set off by accident on a MacBook while
// scrolling. So there it is stopped, page-wide; what is under the pointer and zooms on its own (the
// chat, a terminal, the image viewer) still gets the gesture, since it handles it before it reaches
// the window.
//
// A browser tab keeps page zoom: there it is the browser's, and the user's way to make text bigger.
// The keyboard's Ctrl/Cmd +/- is left alone in the app too, for the same reason.
//
// Chrome and Edge send a trackpad pinch as a wheel event with ctrlKey set; Safari sends gesture
// events.

const INSTALLED = ["standalone", "window-controls-overlay", "minimal-ui", "fullscreen"].map((mode) =>
  window.matchMedia?.(`(display-mode: ${mode})`)
);

/** Whether the page runs as the installed app rather than in a browser tab. */
export function isInstalledApp(): boolean {
  if ((navigator as Navigator & { standalone?: boolean }).standalone) return true;
  return INSTALLED.some((q) => q?.matches);
}

/** Stop pinch and Ctrl+wheel from zooming the page, while it runs as the installed app. */
export function blockPageZoomInApp() {
  const block = (e: Event) => {
    if (isInstalledApp()) e.preventDefault();
  };
  // Not passive: a wheel listener on the window is passive by default, and could not cancel it then.
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) block(e);
    },
    { passive: false }
  );
  // Safari's pinch, in a web app added to the Dock. Not on a touch screen: an iPhone or iPad sends
  // the same events for a two-finger pinch, and there zooming in is how small text gets read.
  if (navigator.maxTouchPoints > 0) return;
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    window.addEventListener(type, block, { passive: false });
  }
}
