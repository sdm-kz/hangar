import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useApi } from "@/lib/node";
import type { WidgetFeedState } from "@/lib/sessionWidgets";
import { cn } from "@/lib/utils";
import { frameZoomStyle } from "./ZoomControls";

// Hangar's colour tokens, handed to a view so it matches the theme around it (guide.md, "Colours").
const THEME_TOKENS = [
  "--background", "--foreground", "--card", "--card-foreground", "--popover", "--popover-foreground",
  "--primary", "--primary-foreground", "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
  "--accent", "--accent-foreground", "--destructive", "--border", "--input", "--ring",
];

function readTheme(): { vars: Record<string, string>; dark: boolean } {
  const css = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const t of THEME_TOKENS) {
    const v = css.getPropertyValue(t).trim();
    if (v) vars[t] = v;
  }
  return { vars, dark: document.documentElement.classList.contains("dark") };
}

interface BridgeMessage {
  __hangar: 1;
  type: string;
  id?: number;
  text?: string;
  url?: string;
  height?: number;
  level?: string;
  message?: string;
  line?: number;
  column?: number;
}

/**
 * A widget's view, in a frame of its own (docs/design/widgets.md §7).
 *
 * The frame is `sandbox="allow-scripts"` and nothing more — no same-origin, so the document has an
 * opaque origin, no cookies and no way into this page — and what it is given is composed by the
 * server with a content-security policy that allows no network at all. It is passed as `srcdoc`
 * rather than a URL so that nothing about loading it needs a credential in a URL. Everything between
 * the two sides goes through the bridge (server/Widgets/Guide/bridge.js), and every message is
 * checked to come from this frame's own window.
 */
export function WidgetFrame({
  sessionId,
  instanceId,
  typeName,
  rev,
  feed,
  onRefresh,
  onToChat,
  onHeight,
  zoom = 1,
  className,
}: {
  sessionId: string;
  instanceId: string;
  typeName: string;
  /** The type's revision: a new one loads the view again. */
  rev: number;
  feed: WidgetFeedState;
  /** Fetch again; resolves to the feed as it is once the answer is in. */
  onRefresh: () => Promise<WidgetFeedState | undefined | void>;
  onToChat: (text: string) => void;
  /** The content's height, for a popover sized to fit it. */
  onHeight?: (px: number) => void;
  /** The page zoom, as an HTML preview has it (see frameZoomStyle); the parent has to clip. */
  zoom?: number;
  className?: string;
}) {
  const api = useApi();
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const ready = useRef(false);
  // The frame can navigate itself away — the sandbox allows that, and no policy inside it stops it. The
  // window it then holds is the same one the bridge talks to, so from the first sign of leaving (the
  // bridge's pagehide, or a second load) nothing more is sent or taken, and the view is mounted afresh.
  // A frame also reloads when its tab is dragged to another group, which looks the same from here, so a
  // reload is only taken for a loop when it keeps happening.
  const cut = useRef(false);
  const loads = useRef(0);
  const [mount, setMount] = useState(0);
  const reloads = useRef<number[]>([]);
  const [stopped, setStopped] = useState(false);
  // The frame's own colour scheme must match its document's, or the browser paints it opaque.
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    let live = true;
    ready.current = false;
    cut.current = false;
    loads.current = 0;
    setHtml(null);
    setLoadError(null);
    api
      .widgetView(sessionId, typeName)
      .then((v) => {
        if (!live) return;
        if (v.html) setHtml(v.html);
        else setLoadError(v.error ?? "The widget has no view.");
      })
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api, sessionId, typeName, rev, mount]);

  // What goes to the frame. Read through a ref by the message handler, which outlives renders.
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const handlers = useRef({ onRefresh, onToChat, onHeight });
  handlers.current = { onRefresh, onToChat, onHeight };

  const post = (msg: Record<string, unknown>) => {
    if (!cut.current) frame.current?.contentWindow?.postMessage({ __hangar: 1, ...msg }, "*");
  };
  const postData = (f: WidgetFeedState = feedRef.current) => {
    const a = f.answer;
    post({
      type: "data",
      data: a?.data ?? null,
      fetchedAt: a?.fetchedAt ?? null,
      error: a?.error ?? f.failure ?? null,
      params: a?.params ?? {},
      loading: f.loading,
    });
  };

  // The view's reports, gathered for a moment and sent together: a view that throws in a loop must
  // not turn into a request per throw.
  const logQueue = useRef<{ level: string; message: string; line?: number; column?: number }[]>([]);
  const logTimer = useRef<number | undefined>(undefined);
  const revRef = useRef(rev);
  revRef.current = rev;
  const flushLog = () => {
    logTimer.current = undefined;
    const entries = logQueue.current.splice(0, 20);
    logQueue.current = [];
    if (entries.length) void api.widgetLog(sessionId, { instance: instanceId, rev: revRef.current, entries }).catch(() => {});
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || cut.current) return;
      const m = e.data as BridgeMessage;
      if (!m || m.__hangar !== 1) return;
      if (m.type === "leaving") {
        cut.current = true;
        return;
      }
      const reply = (value?: unknown, error?: string) => post({ type: "reply", id: m.id, value, error });
      switch (m.type) {
        case "ready":
          ready.current = true;
          post({ type: "theme", ...readTheme() });
          postData();
          break;
        case "refresh":
          // The new data goes first, then the answer: `await hangar.refresh()` sees what it asked for.
          handlers.current.onRefresh().then(
            (state) => {
              if (state) postData(state);
              reply();
            },
            (err) => reply(undefined, String(err))
          );
          break;
        case "toChat":
          // Only straight after a click in the view (a click in a frame counts for the page holding it):
          // a view must not be able to fill the message box on its own, for someone to send unread.
          if (navigator.userActivation && !navigator.userActivation.isActive)
            reply(undefined, "toChat works only in answer to a click");
          else if (typeof m.text === "string" && m.text.trim()) {
            handlers.current.onToChat(m.text);
            reply();
          } else reply(undefined, "nothing to put in the message box");
          break;
        case "openUrl": {
          // Only a web page, in a new tab, with no way back to this one.
          let url: URL | null = null;
          try {
            url = new URL(String(m.url));
          } catch {
            /* not a URL */
          }
          if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
            reply(undefined, "only http(s) links can be opened");
            break;
          }
          const w = window.open(url.toString(), "_blank", "noopener,noreferrer");
          reply(w === null ? "blocked" : "opened");
          break;
        }
        case "size":
        case "resize":
          if (typeof m.height === "number" && m.height > 0) handlers.current.onHeight?.(m.height);
          break;
        case "log":
          logQueue.current.push({
            level: m.level === "warn" ? "warn" : "error",
            message: String(m.message ?? ""),
            line: m.line,
            column: m.column,
          });
          if (logTimer.current === undefined) logTimer.current = window.setTimeout(flushLog, 500);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionId, instanceId]);

  useEffect(() => () => {
    if (logTimer.current !== undefined) {
      window.clearTimeout(logTimer.current);
      flushLog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New data, or a fetch starting or ending: tell the view.
  useEffect(() => {
    if (ready.current) postData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed]);

  // The theme followed live: it changes on the <html> element's class and inline style.
  useEffect(() => {
    const mo = new MutationObserver(() => {
      const theme = readTheme();
      setDark(theme.dark);
      if (ready.current) post({ type: "theme", ...theme });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => mo.disconnect();
  }, []);

  if (loadError)
    return <div className={cn("p-4 text-sm text-destructive", className)}>Could not load the view: {loadError}</div>;
  if (stopped)
    return (
      <div className={cn("p-4 text-sm text-destructive", className)}>
        This view keeps navigating away from itself, so it was stopped. Ask Claude to fix it.
      </div>
    );
  if (html === null)
    return (
      <div className={cn("flex items-center gap-2 p-4 text-sm text-muted-foreground", className)}>
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  return (
    <iframe
      // A new revision is a new document: remounting is what clears whatever the old one left behind.
      key={`${rev}:${mount}`}
      ref={frame}
      onLoad={() => {
        // The first load is the view. Any later one is the frame gone somewhere else, or moved.
        loads.current += 1;
        if (loads.current === 1 && !cut.current) return;
        cut.current = true;
        const now = Date.now();
        reloads.current = [...reloads.current.filter((t) => now - t < 10_000), now];
        logQueue.current.push({
          level: "warn",
          message:
            "The view's frame reloaded — it was moved, or the view navigated away from itself. Hangar reloaded the view. " +
            "Use hangar.openUrl for links; never change location.",
        });
        flushLog();
        if (reloads.current.length >= 3) setStopped(true);
        else setMount((n) => n + 1);
      }}
      title={typeName}
      sandbox="allow-scripts"
      srcDoc={html}
      className={cn("block w-full border-0 bg-transparent", className)}
      // Transparent over the pane's background — as long as the frame and the document inside it agree
      // on light or dark, which the bridge sets from the same theme.
      style={{ colorScheme: dark ? "dark" : "light", ...frameZoomStyle(zoom) }}
    />
  );
}
