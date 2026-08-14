import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { getToken } from "@/lib/api";
import { getTheme, subscribeTheme, type Theme } from "@/lib/theme";
import { writeToClipboard } from "@/lib/clipboard";
import { uploadImageFile } from "@/lib/upload";

// Reading the clipboard (OSC 52 "?" report) is a paste-injection risk, so we never expose it —
// only writes are honored.
const clipboardProvider: IClipboardProvider = {
  readText: () => "",
  writeText: (_selection, text) => writeToClipboard(text),
};

// xterm palettes that track the site theme. The dark one keeps xterm's default ANSI colors (tuned
// for a dark background); the light one remaps the 16 ANSI colors (GitHub-Light-ish) so output
// stays legible on white — the defaults wash out (bright white/yellow) on a light background.
const TERM_THEMES: Record<Theme, ITheme> = {
  dark: {
    background: "#0a0a0a",
    foreground: "#e4e4e7",
    cursor: "#e4e4e7",
    selectionBackground: "#3f3f46",
  },
  light: {
    background: "#ffffff",
    foreground: "#24292e",
    cursor: "#24292e",
    cursorAccent: "#ffffff",
    selectionBackground: "#b3d7ff",
    black: "#24292e",
    red: "#d73a49",
    green: "#22863a",
    yellow: "#b08800",
    blue: "#0366d6",
    magenta: "#6f42c1",
    cyan: "#1b7c83",
    white: "#6a737d",
    brightBlack: "#959da5",
    brightRed: "#cb2431",
    brightGreen: "#28a745",
    brightYellow: "#dbab09",
    brightBlue: "#2188ff",
    brightMagenta: "#8a63d2",
    brightCyan: "#3192aa",
    brightWhite: "#24292e",
  },
};

// Minimal ANSI strip (CSI/OSC/other escapes), with CR collapsed to LF — mirrors the server's Vt.Strip
// so we can pull a clean session name out of the terminal stream.
function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "\n");
}

// A real rename is the OUTPUT of a "/rename" command, not the phrase appearing in assistant prose
// (which used to mis-rename the session to a sentence fragment — even discussing this feature, or
// printing this detector's own regex source, did it). Two layout facts separate a real result from
// prose, and we require BOTH: (1) the "/rename" echo and the confirmation each START a line (prose
// embeds them mid-sentence); (2) the confirmation is a TUI command result, so it's prefixed by a
// non-ASCII tree marker "⎿"/"└" ([^\x00-\x7f]) that assistant markdown never emits — the load-bearing
// discriminator, since plain-ASCII prose can't produce it. Names can contain spaces, so the name is a
// lazy run of printable ASCII; it stops at a 2+ space run or the input prompt ">", which the TUI puts on
// the next line via cursor moves (stripping ANSI drops that, so the prompt can abut, e.g. "main>").
// Trailing spaces trimmed. Mirrors the server sniffer (TerminalChannel.cs).
const RENAME_CONFIRM = /(?:^|[\r\n])[^\w\r\n]{0,12}\/rename\b[^\r\n]*[\s\S]{0,500}?(?:^|[\r\n])[^\w\r\n]{0,15}[^\x00-\x7f][^\w\r\n]{0,8}Session renamed to:[ \t]*([\x20-\x7e]{1,100}?)(?=[^\x20-\x7e]|[ \t]{2,}|[ \t]*>|$)/g;

// Same discriminators for `/color <name>` (line-anchored + a non-ASCII tree marker before the
// confirmation), so the color only updates on genuine "/color" command output, not the phrase in prose.
// The color is a single word (a color name). Mirrors the server sniffer.
const COLOR_CONFIRM = /(?:^|[\r\n])[^\w\r\n]{0,12}\/color\b[^\r\n]*[\s\S]{0,500}?(?:^|[\r\n])[^\w\r\n]{0,15}[^\x00-\x7f][^\w\r\n]{0,8}Session color set to:[ \t]*([A-Za-z]{1,20})/g;

// File-link matcher for the terminal. Two forms:
//  1) a PATH with a separator (optional drive `C:\`, one or more `segment/`, then `name.ext`, any
//     extension) — resolved against the working dir and opened directly.
//  2) a BARE filename with a *known* extension (no directory) — searched for under the working dir
//     (there may be several). The extension whitelist keeps prose like "e.g." or "3.14" from lighting
//     up; paths in form 1 accept any extension since the separator already implies a real path.
// The `(?<!:\/\/)` guard avoids swallowing the domain of an http(s):// URL (the URL provider,
// registered first, keeps precedence there).
const FILE_LINK =
  /(?<!:\/\/)(?:[A-Za-z]:)?[\\/]?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,12}|(?<![\w./\\-])[\w-]+\.(?:md|markdown|txt|log|csv|tsv|json|jsonc|ya?ml|toml|ini|env|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|cs|java|kt|go|rs|rb|php|py|pyi|c|cc|cpp|h|hpp|swift|sql|sh|bash|zsh|ps1|psm1|bat|cmd|dockerfile|gradle|properties|lock|sln|csproj|props|targets)(?![\w])/i;

// Resolve a path clicked in the terminal to an absolute server path. Absolute paths (POSIX, Windows
// drive, or UNC-ish leading separator) pass through; relative paths are joined onto the session's
// working directory. The server's /api/fs/file normalizes mixed separators and `..`, so a plain join
// is enough — no client-side path arithmetic needed.
function resolveTerminalPath(workingDir: string, matched: string): string {
  const isAbsolute = /^([A-Za-z]:[\\/]|[\\/])/.test(matched);
  if (isAbsolute) return matched;
  return workingDir.replace(/[\\/]+$/, "") + "/" + matched;
}

// Imperative handle so a sibling (the postponed-messages pool) can inject a whole message — text
// plus already-uploaded image paths — into the live PTY without owning the socket itself.
// After pasting an image path, Claude Code ingests it asynchronously (reads the file, swaps in an
// "[Image #N]" chip); submitting before that settles makes the Enter get swallowed and the message
// sits unsent in the input box. Wait this long between the image paste(s) and the submit.
const IMAGE_SETTLE_MS = 600;

export interface TerminalPaneHandle {
  // True while the terminal socket is open and can accept input.
  isReady: () => boolean;
  // Send one message to Claude: the text then each image path (both as bracketed pastes so multi-line
  // content stays literal), followed by a single Enter to submit. Resolves false if the socket closed.
  sendMessage: (msg: { text: string; imagePaths: string[] }) => Promise<boolean>;
}

/**
 * Live terminal for a session: an xterm.js terminal wired to the ConPTY-backed WebSocket at
 * /hub/sessions/{id}/terminal. Output frames arrive as binary VT bytes; keystrokes and resizes
 * are sent back (binary input, JSON control). Mount one per session (key by session id).
 */
export const TerminalPane = forwardRef<
  TerminalPaneHandle,
  {
    sessionId: string;
    // The session's working directory, used to resolve a relative file path clicked in the terminal.
    workingDirectory: string;
    // Fired with the new name when Claude's "Session renamed to:" confirmation appears in this
    // terminal, so the app can update the session name immediately instead of waiting for a poll.
    onRenameDetected?: (name: string) => void;
    // Fired with the new color when Claude's "Session color set to:" confirmation appears (a /color
    // typed in the terminal), so the sessions list can recolor immediately instead of on the next poll.
    onColorDetected?: (color: string) => void;
    // Fired with an absolute server path when a full file path in the terminal is clicked, so the app
    // can open it in the main-area file viewer.
    onOpenFile?: (absolutePath: string) => void;
    // Fired with a bare filename (no directory) clicked in the terminal, so the app can search the
    // working directory for it and open it (or offer a picker when several match).
    onFindFile?: (name: string) => void;
  }
>(function TerminalPane(
  { sessionId, workingDirectory, onRenameDetected, onColorDetected, onOpenFile, onFindFile },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Holds the live terminal socket so the imperative handle can write to it; set inside the socket
  // effect below and nulled on teardown. `null` means "not connected" → sendMessage returns false.
  const wsRef = useRef<WebSocket | null>(null);
  // The live xterm instance, so a failed image paste can write its own notice.
  const termRef = useRef<Terminal | null>(null);
  // True while the viewport sits above the live tail — gates the jump-to-bottom button.
  const [scrolledUp, setScrolledUp] = useState(false);
  useImperativeHandle(
    ref,
    (): TerminalPaneHandle => ({
      isReady: () => wsRef.current?.readyState === WebSocket.OPEN,
      sendMessage: async ({ text, imagePaths }) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        const enc = new TextEncoder();
        // Bracketed paste keeps any embedded newlines literal; the separate trailing \r is the one
        // submit — sending raw \n/\r inside the text would split one message into several prompts.
        if (text) ws.send(enc.encode(`\x1b[200~${text}\x1b[201~`));
        for (const p of imagePaths) ws.send(enc.encode(`\x1b[200~${p}\x1b[201~`));
        // Let Claude Code finish ingesting any pasted image before we submit, or the Enter is lost.
        if (imagePaths.length) await new Promise((r) => setTimeout(r, IMAGE_SETTLE_MS));
        const live = wsRef.current;
        if (!live || live.readyState !== WebSocket.OPEN) return false;
        live.send(enc.encode("\r"));
        return true;
      },
    }),
    []
  );
  // Kept in refs so the link/socket handlers always see the latest values without re-opening the socket.
  const onRenameRef = useRef(onRenameDetected);
  onRenameRef.current = onRenameDetected;
  const onColorRef = useRef(onColorDetected);
  onColorRef.current = onColorDetected;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onFindFileRef = useRef(onFindFile);
  onFindFileRef.current = onFindFile;
  const workingDirRef = useRef(workingDirectory);
  workingDirRef.current = workingDirectory;
  // Rolling tail of recent output (ANSI-stripped) so a confirmation split across frames still matches.
  // Shared by the rename and color detectors.
  const scanBufRef = useRef("");
  const lastNameRef = useRef<string | null>(null);
  const lastColorRef = useRef<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 10000,
      theme: TERM_THEMES[getTheme()],
    });
    termRef.current = term;
    // Re-theme live when the site theme is toggled.
    const themeSub = subscribeTheme((t) => {
      term.options.theme = TERM_THEMES[t];
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Honor OSC 52 clipboard writes (how Claude Code copies), routing them to the browser clipboard.
    term.loadAddon(new ClipboardAddon(undefined, clipboardProvider));
    // Detect URLs and open them in a new tab. On desktop require Ctrl/Cmd-click so plain clicks stay
    // free for selection and the TUI; on touch (no modifier keys) a plain tap opens.
    const isTouch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (isTouch || event.ctrlKey || event.metaKey)
          window.open(uri, "_blank", "noopener,noreferrer");
      })
    );
    // Detect file paths and open them in the app's file viewer. WebLinksAddon can't be reused here —
    // it validates every match with `new URL()`, so non-URL paths are discarded — so we register a
    // custom link provider. It reconstructs each logical line (joining wrapped rows so a long path
    // spanning terminal rows stays a single link), matches FILE_PATH, and maps string indices back to
    // 1-based buffer cells. Same click gating as URLs; relative paths resolve against the working dir.
    const fileLinks = term.registerLinkProvider({
      provideLinks(bufferLine, cb) {
        const buf = term.buffer.active;
        const startRow = bufferLine - 1; // provideLinks is 1-based; getLine is 0-based
        const first = buf.getLine(startRow);
        // Skip wrapped continuation rows — each logical line is handled once at its first row.
        if (!first || first.isWrapped) return cb(undefined);

        const rows = [first.translateToString(false)]; // untrimmed → each row is exactly `cols` wide
        for (let i = startRow + 1; i < buf.length; i++) {
          const l = buf.getLine(i);
          if (!l || !l.isWrapped) break;
          rows.push(l.translateToString(false));
        }
        const cols = term.cols;
        const text = rows.join("");
        const cell = (idx: number) => ({ x: (idx % cols) + 1, y: startRow + Math.floor(idx / cols) + 1 });

        const links = [...text.matchAll(new RegExp(FILE_LINK.source, "gi"))].map((m) => {
          const matched = m[0];
          const idx = m.index ?? 0;
          return {
            text: matched,
            range: { start: cell(idx), end: cell(idx + matched.length) },
            decorations: { pointerCursor: true, underline: true },
            activate: (event: MouseEvent, uri: string) => {
              if (!(isTouch || event.ctrlKey || event.metaKey)) return;
              const t = uri.trim();
              // A separator means it's a real path (resolve + open); otherwise it's a bare filename
              // to search for under the working directory.
              if (/[\\/]/.test(t)) onOpenFileRef.current?.(resolveTerminalPath(workingDirRef.current, t));
              else onFindFileRef.current?.(t);
            },
          };
        });
        cb(links.length ? links : undefined);
      },
    });
    term.open(host);
    // GPU renderer. The default DOM renderer rebuilds row elements on every scroll step, which is
    // what makes touch scrolling lag behind the finger on phones; WebGL repaints the whole grid in
    // one draw call. Must be loaded after open() (it needs the canvas parent). Mobile browsers drop
    // the GL context when the tab is backgrounded or memory is tight — dispose on loss so xterm
    // falls back to the DOM renderer instead of freezing on a dead canvas.
    // The addon version is pinned to the core's (0.18.x ↔ xterm 5.5.x): 0.19's teardown reads
    // `_core._store._isDisposed`, an internal that only exists in the 5.6 betas, so on 5.5 it threw
    // out of this effect's cleanup and blanked the app on every session switch.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      webgl = null; // no WebGL available (old browser / blocked) — DOM renderer stays
    }
    try {
      fit.fit();
    } catch {
      /* container not measured yet */
    }

    const token = getToken() ?? "";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/hub/sessions/${sessionId}/terminal?access_token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws; // expose to the imperative handle (sendMessage)

    const sendResize = () => {
      // Skip while the pane is hidden (e.g. the Files full view keeps us mounted but
      // display:none'd): fitting a 0-sized host would send a bogus 1x1 resize to the PTY.
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      // Repaint xterm's own cells in case the renderer left them stale after being hidden.
      term.refresh(0, term.rows - 1);
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    // Force Claude Code to repaint its full TUI by nudging the PTY size (cols-1, then back). The
    // server shares one ConPTY across viewers and ignores a same-size resize, so a fresh xterm
    // reattaching at the current size (e.g. after a session switch) gets only the replayed
    // scrollback and no SIGWINCH — leaving Claude's input box unpainted until you manually resize.
    // A one-column nudge guarantees a resize signal, which makes Ink redraw the whole frame. We
    // nudge columns rather than rows so the redraw doesn't shift rows vertically (a row nudge bumps
    // the input box up a line and back — a visible top/bottom jump).
    const nudgeRepaint = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      const cols = term.cols;
      const rows = term.rows;
      if (cols <= 1) return;
      ws.send(JSON.stringify({ type: "resize", cols: cols - 1, rows }));
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }, 60);
    };

    ws.onopen = () => {
      // The flex layout may still be settling on open; refit across a few frames so the size we
      // send matches what's actually displayed (otherwise Claude renders at a stale row count).
      sendResize();
      requestAnimationFrame(sendResize);
      setTimeout(sendResize, 150);
      setTimeout(() => {
        sendResize();
        nudgeRepaint(); // once the size has settled, force a fresh full-screen repaint from Claude
      }, 400);
    };
    const decoder = new TextDecoder();
    ws.onmessage = (e) => {
      let text: string;
      if (typeof e.data === "string") {
        term.write(e.data);
        text = e.data;
      } else {
        const bytes = new Uint8Array(e.data);
        term.write(bytes);
        text = decoder.decode(bytes, { stream: true });
      }
      // Watch for Claude's "Session renamed to: <name>" confirmation and apply the new name directly.
      // Accumulate every frame (the confirmation's phrase and name can arrive in separate frames), and
      // require a following boundary char so the newest name — which the TUI ends with a box-drawing
      // char, not a newline — is captured cleanly instead of lagging a rename behind.
      scanBufRef.current = (scanBufRef.current + stripAnsi(text)).slice(-2048);
      if (scanBufRef.current.includes("Session renamed to:")) {
        let name: string | null = null;
        for (const m of scanBufRef.current.matchAll(RENAME_CONFIRM)) {
          name = m[1].trimEnd(); // last (most recent) confirmation wins; drop panel pad spaces
        }
        if (name && name !== lastNameRef.current) {
          lastNameRef.current = name;
          onRenameRef.current?.(name);
        }
      }
      // Same detection for a `/color <name>` typed in the terminal.
      if (scanBufRef.current.includes("Session color set to:")) {
        let color: string | null = null;
        for (const m of scanBufRef.current.matchAll(COLOR_CONFIRM)) color = m[1];
        if (color && color !== lastColorRef.current) {
          lastColorRef.current = color;
          onColorRef.current?.(color);
        }
      }
    };
    ws.onclose = () => term.write("\r\n\x1b[90m[terminal disconnected]\x1b[0m\r\n");

    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(new TextEncoder().encode(d));
    });

    // Paste an image (e.g. a screenshot) into the terminal: upload it into the session's working
    // dir, then inject its path as a bracketed paste so Claude Code picks it up (like a drag-drop).
    // Non-image pastes fall through to xterm's normal text handling. Listens on document in the
    // capture phase so it fires before xterm processes the paste, regardless of focus target.
    const onPaste = async (e: ClipboardEvent) => {
      // Let the postponed-messages pool handle its own pastes: this capture-phase listener would
      // otherwise swallow an image pasted into the pool's composer before it bubbles to the textarea.
      if ((e.target as HTMLElement | null)?.closest?.("[data-postponed-pool]")) return;
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      try {
        const { fullPath } = await uploadImageFile(sessionId, file);
        if (ws.readyState === WebSocket.OPEN)
          ws.send(new TextEncoder().encode(`\x1b[200~${fullPath}\x1b[201~`));
      } catch {
        term.write("\r\n\x1b[31m[image paste failed]\x1b[0m\r\n");
      }
    };
    document.addEventListener("paste", onPaste, true);

    // Touch scrolling: xterm's built-in viewport touch handler only fires for touches that land on
    // the thin scrollbar viewport, but on mobile a drag lands on the screen overlay and never reaches
    // it — so scrollback is unreachable. Translate a one-finger vertical drag into scroll movement
    // ourselves. A tap (no meaningful move) falls through untouched, so tap-to-focus still works.
    //
    // Beyond the drag itself we add flick momentum: without it the content stops dead the instant the
    // finger lifts, which is the main reason this feels unlike a native scroll view. We track recent
    // pointer velocity, and on release keep scrolling with exponential decay until it dies out.
    const rowHeightOf = () =>
      // Guard both terms: a zero-height host (hidden pane) would otherwise divide to Infinity lines.
      host.clientHeight > 0 && term.rows > 0 ? host.clientHeight / term.rows : 18;

    // Apply `lines` of scroll, picking the mechanism the CURRENT buffer actually responds to.
    // Claude Code's TUI runs in the ALTERNATE screen buffer, which by definition has no scrollback:
    // there, `scrollLines` is a silent no-op and the only thing that moves the view is the app's own
    // scrolling, driven by arrow keys. xterm already implements exactly that translation in its wheel
    // handler (alt buffer + wheel → N cursor-key sequences, honoring DECCKM application-cursor mode),
    // so we hand it a synthetic wheel of the equivalent pixel delta rather than re-deriving the escape
    // sequences here. In the normal buffer (a plain shell) there IS scrollback, and scrollLines is the
    // direct path — no round trip through the PTY. Returns whether the view actually moved.
    const applyScroll = (lines: number, rowHeight: number): boolean => {
      if (term.buffer.active.type === "alternate") {
        const screen = host.querySelector(".xterm-screen");
        if (!screen) return false;
        // Untrusted events perform no default action, so this can't scroll the page — xterm's own
        // listener is the only thing that reacts to it.
        screen.dispatchEvent(
          new WheelEvent("wheel", { deltaY: lines * rowHeight, deltaMode: 0, bubbles: true, cancelable: true })
        );
        return true; // the app owns the scroll; we can't observe whether it hit an end
      }
      const before = term.buffer.active.viewportY;
      term.scrollLines(lines);
      return term.buffer.active.viewportY !== before;
    };
    let lastTouchY: number | null = null;
    let scrollAccum = 0; // sub-row remainder, carried across moves so slow drags still track 1:1
    let velocity = 0; // px per frame, signed like scrollAccum (positive = toward newer output)
    let lastMoveTs = 0;
    let momentumRaf = 0;
    const stopMomentum = () => {
      if (momentumRaf) cancelAnimationFrame(momentumRaf);
      momentumRaf = 0;
      velocity = 0;
    };
    const onTouchStart = (e: TouchEvent) => {
      stopMomentum(); // a new touch always grabs the content, mid-glide included
      if (e.touches.length === 1) {
        lastTouchY = e.touches[0].clientY;
        scrollAccum = 0;
        lastMoveTs = e.timeStamp;
      } else {
        lastTouchY = null; // pinch/multi-touch: let the browser handle it
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || lastTouchY === null) return;
      const y = e.touches[0].clientY;
      const dy = lastTouchY - y; // dragging up (finger up) scrolls content up = toward newer
      scrollAccum += dy;
      lastTouchY = y;
      // Normalize to px-per-frame (~16.7ms) and smooth, so one jittery sample can't define the flick.
      const dt = Math.max(1, e.timeStamp - lastMoveTs);
      lastMoveTs = e.timeStamp;
      velocity = velocity * 0.7 + (dy / dt) * 16.7 * 0.3;
      const rowHeight = rowHeightOf();
      const lines = Math.trunc(scrollAccum / rowHeight);
      if (lines !== 0) {
        applyScroll(lines, rowHeight);
        scrollAccum -= lines * rowHeight;
      }
      // Own the gesture as soon as it reads as a vertical drag — even before a full row of travel —
      // so the page underneath never pans or pull-to-refreshes mid-scroll.
      if (Math.abs(scrollAccum) > 2 || lines !== 0) e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      lastTouchY = null;
      // A stale sample (finger held still before lifting) must not fling; require a recent, fast move.
      if (e.timeStamp - lastMoveTs > 80 || Math.abs(velocity) < 1.5) {
        velocity = 0;
        return;
      }
      const step = () => {
        velocity *= 0.94; // ~0.5s glide; slower decay overshoots and feels slippery in a terminal
        if (Math.abs(velocity) < 0.4) return stopMomentum();
        scrollAccum += velocity;
        const rowHeight = rowHeightOf();
        const lines = Math.trunc(scrollAccum / rowHeight);
        if (lines !== 0) {
          const moved = applyScroll(lines, rowHeight);
          scrollAccum -= lines * rowHeight;
          if (!moved) return stopMomentum(); // hit top/bottom — don't keep spinning
        }
        momentumRaf = requestAnimationFrame(step);
      };
      momentumRaf = requestAnimationFrame(step);
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: true });
    host.addEventListener("touchcancel", stopMomentum, { passive: true });

    // Drive the jump-to-bottom button: it only makes sense while the viewport is off the live tail.
    // A few rows of slack keeps it from flickering on the last sliver of a drag.
    const scrollSub = term.onScroll(() => {
      const buf = term.buffer.active;
      setScrolledUp(buf.baseY - buf.viewportY > 2);
    });

    // Refit + notify the PTY whenever the pane resizes.
    const ro = new ResizeObserver(() => sendResize());
    ro.observe(host);

    // Backgrounding the tab throttles rAF/timers and pauses xterm's renderer; the ResizeObserver
    // stays silent because the size never changed, so nothing refits on return. Refit across a
    // couple frames whenever we become visible again (also covers OS-level tab/app switches).
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // The socket stayed open across the tab switch, so xterm's buffer is intact — just refit and
      // repaint the existing cells. No size nudge here: forcing Claude to reflow would jump the
      // scroll position. The nudge only belongs on a fresh reattach (see ws.onopen).
      sendResize();
      requestAnimationFrame(sendResize);
      setTimeout(sendResize, 150);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      ro.disconnect();
      fileLinks.dispose();
      scrollSub.dispose();
      stopMomentum();
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", stopMomentum);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("paste", onPaste, true);
      themeSub();
      dataSub.dispose();
      wsRef.current = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      termRef.current = null;
      // Hand the renderer back to the DOM one while the core is still alive, then dispose. Letting
      // term.dispose() unload the WebGL addon instead runs its teardown against a half-disposed
      // core, which throws — and a throw in an effect cleanup takes the whole React tree down with
      // it (white page). Both steps are guarded so a renderer hiccup can never escape unmount.
      try {
        webgl?.dispose();
      } catch {
        /* renderer already gone (context loss) */
      }
      webgl = null;
      try {
        term.dispose();
      } catch {
        /* nothing left to salvage at unmount */
      }
    };
  }, [sessionId]);

  // Padding lives on the outer wrapper, not the host: FitAddon measures the host (the xterm's
  // parent) and only discounts padding on the .xterm element itself, so any padding here would make
  // it overcount rows and clip the last line. The host stays padding-free and edge-to-edge.
  return (
    <div className="relative h-full w-full bg-white p-2 dark:bg-[#0a0a0a]">
      <div ref={hostRef} className="h-full w-full overscroll-contain overflow-hidden" />
      {/* Scrolled off the live tail: one tap back to the bottom, instead of flicking through
          scrollback. The only thing floating over the terminal now — image attach lives in the
          postponed panel's bar, next to Compose. */}
      {scrolledUp && (
        <button
          type="button"
          onClick={() => termRef.current?.scrollToBottom()}
          title="Jump to the latest output"
          aria-label="Jump to the latest output"
          className="absolute bottom-4 right-4 rounded-full border bg-background/90 p-3 text-muted-foreground shadow-md backdrop-blur transition hover:text-foreground"
        >
          <ArrowDown className="size-5" />
        </button>
      )}
    </div>
  );
});
