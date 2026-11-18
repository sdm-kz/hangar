// Hangar widget bridge — put in front of every widget view by the server (WidgetGuide.Compose).
// The view runs in a sandboxed frame with no origin and no network requests; this is its only line
// out, postMessage to the Hangar page that holds it. Docs: GET /api/self/widgets/guide, "The view".
(() => {
  "use strict";
  const send = (type, body) => {
    try { parent.postMessage(Object.assign({ __hangar: 1, type }, body || {}), "*"); } catch { /* page gone */ }
  };
  const text = (x) => {
    if (typeof x === "string") return x;
    if (x && x.stack) return String(x.stack);
    try { return JSON.stringify(x); } catch { return String(x); }
  };
  const report = (level, message, line, column) =>
    send("log", { level, message: String(message).slice(0, 2000), line: line || undefined, column: column || undefined });

  // Everything that goes wrong in the view is reported, so the session that wrote it can read it back
  // (GET /api/self/widgets/instances/{id}/log): it cannot see the page.
  window.addEventListener("error", (e) => report("error", e.message || text(e.error), e.lineno, e.colno));
  window.addEventListener("unhandledrejection", (e) => report("error", "Unhandled rejection: " + text(e.reason)));
  for (const level of ["error", "warn"]) {
    const original = console[level];
    console[level] = (...args) => {
      report(level, args.map(text).join(" "));
      original.apply(console, args);
    };
  }

  const listeners = [];
  let last = null;
  let seq = 0;
  const pending = new Map();

  const deliver = (fn, m) => {
    try {
      fn(m.data, { fetchedAt: m.fetchedAt, error: m.error, params: m.params, loading: m.loading });
    } catch (err) {
      report("error", text(err));
    }
  };
  const request = (type, body) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      send(type, Object.assign({ id }, body || {}));
    });

  const hangar = {
    /** The current theme: Hangar's colour tokens (--background, --foreground, --muted, …) and `dark`. */
    theme: { dark: false },
    /** fn(data, { fetchedAt, error, params, loading }) now if there is data, and on every refresh. */
    onData(fn) {
      listeners.push(fn);
      if (last) deliver(fn, last);
    },
    /** Fetch again now. Resolves when the new data (or error) has been delivered. */
    refresh() { return request("refresh"); },
    /** Put text in the session's message box, without sending it. */
    toChat(value) { return request("toChat", { text: String(value) }); },
    /** Open an http(s) link in a new browser tab. Call it from a click. */
    openUrl(url) { return request("openUrl", { url: String(url) }); },
    /** Ask for a popover height that fits the content (popovers also follow the content on their own). */
    resize(height) { send("resize", { height: Number(height) || 0 }); },
  };
  Object.defineProperty(window, "hangar", { value: hangar, writable: false, configurable: false });

  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.__hangar !== 1) return;
    if (m.type === "data") {
      last = m;
      for (const fn of listeners) deliver(fn, m);
    } else if (m.type === "theme") {
      const root = document.documentElement;
      for (const k of Object.keys(m.vars || {})) root.style.setProperty(k, m.vars[k]);
      root.style.colorScheme = m.dark ? "dark" : "light";
      root.dataset.theme = m.dark ? "dark" : "light";
      hangar.theme = Object.assign({}, m.vars, { dark: !!m.dark });
    } else if (m.type === "reply") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.value);
    }
  });

  // The content's height, for a popover sized to fit it. The body's, not the document's: in a frame the
  // document is never shorter than the frame, so a popover measured by it could grow but never shrink.
  const measure = () => {
    const b = document.body;
    if (!b) return;
    const css = getComputedStyle(b);
    send("size", { height: Math.ceil(b.getBoundingClientRect().height + parseFloat(css.marginTop) + parseFloat(css.marginBottom)) });
  };
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(measure);
    const watch = () => { if (document.body) ro.observe(document.body); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
    else watch();
  }
  // Leaving: registered before the view's own code runs, so nothing in the view can get in ahead of
  // it. The page stops talking to this frame from here, and remounts it if it went anywhere.
  window.addEventListener("pagehide", () => send("leaving"));
  send("ready");
})();
