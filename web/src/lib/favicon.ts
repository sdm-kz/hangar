// Badge the browser-tab favicon with a status dot, so a backgrounded tab still tells you whether
// Claude is working somewhere (green) or waiting on you (amber). The icon is the same robot emoji
// declared in index.html, re-emitted as an SVG data URI with a circle drawn over its top-right
// corner — no canvas, no image assets.

export type FaviconStatus = "idle" | "busy" | "waiting";

// Matches the sidebar's activity dots: emerald-500 for working, amber-400 for waiting on you.
const DOT: Record<Exclude<FaviconStatus, "idle">, string> = {
  busy: "#10b981",
  waiting: "#fbbf24",
};

function svg(status: FaviconStatus) {
  // The badge carries a white ring so it stays legible against the robot at 16px, where the dot is
  // only a few pixels across.
  const dot =
    status === "idle"
      ? ""
      : `<circle cx="74" cy="26" r="24" fill="${DOT[status]}" stroke="#fff" stroke-width="8"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<text y=".9em" font-size="90">\u{1F916}</text>${dot}</svg>`
  );
}

let current: FaviconStatus | null = null;

/** Repaint the tab favicon for `status` (no-op if it's already showing that badge). */
export function setFaviconStatus(status: FaviconStatus) {
  if (status === current) return;
  current = status;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = `data:image/svg+xml,${encodeURIComponent(svg(status))}`;
}
