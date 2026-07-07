import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getToken } from "@/lib/api";

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
      theme: { background: "#0a0a0a", foreground: "#e4e4e7" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
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

    // Refit + notify the PTY whenever the pane resizes.
    const ro = new ResizeObserver(() => sendResize());
    ro.observe(host);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={hostRef} className="h-full w-full bg-[#0a0a0a] p-2" />;
}
