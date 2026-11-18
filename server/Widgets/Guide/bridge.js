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

  // ---- Markdown -----------------------------------------------------------------------------------
  // What a ticket, a PR or a page description usually is. Rendered into elements with textContent
  // only, never through innerHTML, so text someone else wrote cannot become markup in the view. The
  // common subset: headings, paragraphs, lists (nested), fenced code, quotes, rules, pipe tables;
  // code, bold, italic, strikethrough, links (opened with openUrl) and backslash escapes. Styled by
  // the .hangar-md rules Hangar puts in front of the view, in the theme's colours.
  const el = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isRule = (l) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
  const startsBlock = (l) =>
    /^\s{0,3}(#{1,6}\s|```|~~~|>)/.test(l) || isRule(l) || ITEM.test(l) || isRow(l);

  const link = (label, href) => {
    const safe = /^https?:\/\//i.test(href);
    const a = el(safe ? "a" : "span");
    inline(label, a);
    if (safe) {
      a.title = href;
      a.tabIndex = 0;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        hangar.openUrl(href);
      });
    }
    return a;
  };

  function inline(text, into) {
    let buf = "";
    const flush = () => {
      if (buf) into.append(buf);
      buf = "";
    };
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      const rest = text.slice(i);
      let m;
      if (c === "\\" && /[\\`*_{}[\]()#+\-.!|~"'<>]/.test(text[i + 1] || "")) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
      if (c === "`" && (m = rest.match(/^(`+)([\s\S]*?[^`])\1(?!`)/))) {
        flush();
        const code = el("code");
        code.textContent = m[2].trim();
        into.append(code);
        i += m[0].length;
        continue;
      }
      if (c === "[" && (m = rest.match(/^\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/))) {
        flush();
        into.append(link(m[1], m[2]));
        i += m[0].length;
        continue;
      }
      if ((c === "h" || c === "H") && (i === 0 || /[\s(]/.test(text[i - 1])) && (m = rest.match(/^https?:\/\/[^\s<>]*[^\s<>().,;:!?'"]/i))) {
        flush();
        into.append(link(m[0], m[0]));
        i += m[0].length;
        continue;
      }
      if ((c === "*" || c === "_") && (m = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/))) {
        flush();
        const b = el("strong");
        inline(m[2], b);
        into.append(b);
        i += m[0].length;
        continue;
      }
      if (c === "~" && (m = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/))) {
        flush();
        const s = el("del");
        inline(m[1], s);
        into.append(s);
        i += m[0].length;
        continue;
      }
      // An underscore inside a word (snake_case) is not emphasis.
      if ((c === "*" || (c === "_" && !/\w/.test(text[i - 1] || ""))) && (m = rest.match(c === "*" ? /^\*(?=\S)([\s\S]*?\S)\*/ : /^_(?=\S)([\s\S]*?\S)_(?!\w)/))) {
        flush();
        const em = el("em");
        inline(m[1], em);
        into.append(em);
        i += m[0].length;
        continue;
      }
      buf += c;
      i++;
    }
    flush();
  }

  function list(lines, i) {
    const first = lines[i].match(ITEM);
    const indent = first[1].length;
    const out = el(/\d/.test(first[2]) ? "ol" : "ul");
    let li = null;
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(ITEM);
      if (!line.trim()) {
        // A blank line inside a list keeps it going when an item follows.
        const next = (lines[i + 1] || "").match(ITEM);
        if (next && next[1].length >= indent) { i++; continue; }
        break;
      }
      if (m && m[1].length >= indent + 2 && li) {
        const [sub, at] = list(lines, i);
        li.append(sub);
        i = at;
        continue;
      }
      if (m && m[1].length < indent) break;
      if (m) {
        li = el("li");
        inline(m[3], li);
        out.append(li);
        i++;
        continue;
      }
      if (li && /^\s+\S/.test(line) && !startsBlock(line)) {
        li.append(" ");
        inline(line.trim(), li);
        i++;
        continue;
      }
      break;
    }
    return [out, i];
  }

  function table(lines, i) {
    const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const t = el("table");
    const thead = el("thead");
    const head = el("tr");
    for (const c of cells(lines[i])) {
      const th = el("th");
      inline(c, th);
      head.append(th);
    }
    thead.append(head);
    const body = el("tbody");
    i += 2;
    while (i < lines.length && isRow(lines[i])) {
      const tr = el("tr");
      for (const c of cells(lines[i])) {
        const td = el("td");
        inline(c, td);
        tr.append(td);
      }
      body.append(tr);
      i++;
    }
    t.append(thead, body);
    return [t, i];
  }

  function blocks(src, root) {
    const lines = src.replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) { i++; continue; }
      if ((m = line.match(/^\s{0,3}(```|~~~)/))) {
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(m[1])) body.push(lines[i++]);
        i++;
        const pre = el("pre");
        const code = el("code");
        code.textContent = body.join("\n");
        pre.append(code);
        root.append(pre);
        continue;
      }
      if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        const h = el("h" + m[1].length);
        inline(m[2], h);
        root.append(h);
        i++;
        continue;
      }
      if (isRule(line)) { root.append(el("hr")); i++; continue; }
      if (/^\s{0,3}>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
        const q = el("blockquote");
        blocks(quoted.join("\n"), q);
        root.append(q);
        continue;
      }
      if (isRow(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
        const [t, at] = table(lines, i);
        root.append(t);
        i = at;
        continue;
      }
      if (ITEM.test(line)) {
        const [l, at] = list(lines, i);
        root.append(l);
        i = at;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++].trim());
      const p = el("p");
      inline(para.join(" "), p);
      root.append(p);
    }
    return root;
  }

  const hangar = {
    /**
     * Markdown as elements, ready to append: `node.replaceChildren(hangar.markdown(text))`. Built with
     * textContent throughout, so it is safe for text someone else wrote; links open in a browser tab.
     */
    markdown(text) { return blocks(String(text ?? ""), el("div", "hangar-md")); },
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
