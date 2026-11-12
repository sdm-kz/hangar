// The badge on the installed app's icon — the Windows taskbar, the macOS Dock, an iPhone's home
// screen — through the Badging API. It can only be a number or a plain dot, so the two say different
// things: a number counts the sessions blocked on you (a question, a permission, a turn that died),
// a dot says only that something finished that you haven't looked at. Nothing else earns a badge: a
// working session needs nothing from you, and a badge that changes all day is one you stop reading.
//
// Only an installed app shows it; in a browser tab the calls succeed and draw nothing, which is fine.
// The service worker sets the same badge from a push while no window is open (public/sw.js).

export type AppBadge = { count: number } | "dot" | "none";

let current: string | null = null;

/** Show `badge` on the app icon (no-op where unsupported, or if it's already showing that). */
export function setAppBadge(badge: AppBadge) {
  const key = typeof badge === "string" ? badge : String(badge.count);
  if (key === current) return;
  current = key;
  if (!("setAppBadge" in navigator)) return;
  // Rejects where the platform says no (an iPhone without notification permission): nothing to do.
  const done = (p: Promise<void>) => void p.catch(() => {});
  if (badge === "none") done(navigator.clearAppBadge());
  else if (badge === "dot") done(navigator.setAppBadge());
  else done(navigator.setAppBadge(badge.count));
}
