import { useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import { api, getToken } from "@/lib/api";
import { getTheme, subscribeTheme, type Theme } from "@/lib/theme";
import { writeToClipboard } from "@/lib/clipboard";

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

// Claude's confirmation line, e.g. "Session renamed to: my-name". The name is captured as a slug
// token that stops at the first non-name char (space, newline, box-drawing/spinner glyph). We do NOT
// require a trailing newline: the TUI leaves the newest confirmation without one (it's the last line,
// drawn with cursor moves), so requiring a newline would always lag one rename behind.
const RENAME_CONFIRM = /Session renamed to:\s*([A-Za-z0-9._\/-]{1,64})[^A-Za-z0-9._\/-]/g;

/**
 * Live terminal for a session: an xterm.js terminal wired to the ConPTY-backed WebSocket at
 * /hub/sessions/{id}/terminal. Output frames arrive as binary VT bytes; keystrokes and resizes
 * are sent back (binary input, JSON control). Mount one per session (key by session id).
 */
export function TerminalPane({
  sessionId,
  onRenameDetected,
}: {
  sessionId: string;
  // Fired with the new name when Claude's "Session renamed to:" confirmation appears in this
  // terminal, so the app can update the session name immediately instead of waiting for a poll.
  onRenameDetected?: (name: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Kept in a ref so the socket handler always sees the latest callback without re-opening the socket.
  const onRenameRef = useRef(onRenameDetected);
  onRenameRef.current = onRenameDetected;
  // Rolling tail of recent output (ANSI-stripped) so a confirmation split across frames still matches.
  const renameBufRef = useRef("");
  const lastNameRef = useRef<string | null>(null);

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
    // Re-theme live when the site theme is toggled.
    const themeSub = subscribeTheme((t) => {
      term.options.theme = TERM_THEMES[t];
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Honor OSC 52 clipboard writes (how Claude Code copies), routing them to the browser clipboard.
    term.loadAddon(new ClipboardAddon(undefined, clipboardProvider));
    term.open(host);
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
      renameBufRef.current = (renameBufRef.current + stripAnsi(text)).slice(-2048);
      if (renameBufRef.current.includes("Session renamed to:")) {
        let name: string | null = null;
        for (const m of renameBufRef.current.matchAll(RENAME_CONFIRM)) {
          name = m[1]; // last (most recent) confirmation in the buffer wins
        }
        if (name && name !== lastNameRef.current) {
          lastNameRef.current = name;
          onRenameRef.current?.(name);
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
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      const ext = file.type.split("/")[1] || "png";
      try {
        const dataUrl: string = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = () => rej(r.error);
          r.readAsDataURL(file);
        });
        const b64 = dataUrl.split(",", 2)[1] ?? "";
        const { fullPath } = await api.uploadSessionImage(sessionId, b64, ext);
        if (ws.readyState === WebSocket.OPEN)
          ws.send(new TextEncoder().encode(`\x1b[200~${fullPath}\x1b[201~`));
      } catch {
        term.write("\r\n\x1b[31m[image paste failed]\x1b[0m\r\n");
      }
    };
    document.addEventListener("paste", onPaste, true);

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
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("paste", onPaste, true);
      themeSub();
      dataSub.dispose();
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      term.dispose();
    };
  }, [sessionId]);

  // Padding lives on the outer wrapper, not the host: FitAddon measures the host (the xterm's
  // parent) and only discounts padding on the .xterm element itself, so any padding here would make
  // it overcount rows and clip the last line. The host stays padding-free and edge-to-edge.
  return (
    <div className="h-full w-full bg-white p-2 dark:bg-[#0a0a0a]">
      <div ref={hostRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}
