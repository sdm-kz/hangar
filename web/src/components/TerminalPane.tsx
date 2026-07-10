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

/**
 * Live terminal for a session: an xterm.js terminal wired to the ConPTY-backed WebSocket at
 * /hub/sessions/{id}/terminal. Output frames arrive as binary VT bytes; keystrokes and resizes
 * are sent back (binary input, JSON control). Mount one per session (key by session id).
 */
export function TerminalPane({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

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
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onopen = () => {
      // The flex layout may still be settling on open; refit across a few frames so the size we
      // send matches what's actually displayed (otherwise Claude renders at a stale row count).
      sendResize();
      requestAnimationFrame(sendResize);
      setTimeout(sendResize, 150);
      setTimeout(sendResize, 400);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") term.write(e.data);
      else term.write(new Uint8Array(e.data));
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

    return () => {
      ro.disconnect();
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
