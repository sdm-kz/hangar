// Write text to the clipboard. Prefer the async Clipboard API, but fall back to a hidden-textarea
// execCommand copy when it's unavailable — e.g. the app served over plain http on a LAN IP, where
// the page isn't a secure context and navigator.clipboard doesn't exist. Resolves to whether it took.
export async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* clipboard API blocked (lost focus / permission) — fall back to execCommand below */
  }
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    /* nothing else to try */
  }
  document.body.removeChild(ta);
  prev?.focus?.();
  return ok;
}
