// Makes links usable in the rendered Word preview (docx-preview output), covering three cases:
//
//  1. External hyperlinks — docx-preview emits a bare <a href="https://…">, which navigates the whole
//     SPA away from the app (killing the session view and its terminal socket). We force them into a
//     new tab instead.
//  2. Real internal links — a `w:hyperlink w:anchor` renders as <a href="#name"> and its bookmark as
//     <span id="name">. Native fragment navigation works, but it pushes "#name" into the app's URL,
//     which the Files panel also uses for markdown section anchors. We scroll them ourselves instead.
//  3. Documents with the *look* of a table of contents but no links at all — no <w:hyperlink>, no
//     bookmarks, just entries formatted in blue + underline. Common in generated .docx files. There
//     is nothing to follow, so we reconstruct the targets: an entry is paired with the one other
//     paragraph in the document carrying the same text, and clicking it jumps there.
//
// Case 3 is deliberately conservative — it only fires when a paragraph looks like a link AND its text
// matches exactly one other paragraph, so ordinary repeated text is never turned into a control.

/** Ignore paragraphs shorter than this when pairing, so page numbers and stray "1." don't match. */
const MIN_ENTRY_CHARS = 6;

/** How long the landing paragraph stays highlighted after a jump. Matches the CSS animation. */
const FLASH_MS = 1200;

/** Collapse whitespace/case and drop trailing dots so a TOC entry matches its heading. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase().replace(/[.·]+$/, "");
}

/** True for black/grey text — link styling means a *colored* underline, not just any underline. */
function isNeutral(color: string): boolean {
  const [r, g, b] = (color.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  if ([r, g, b].some((v) => v === undefined || Number.isNaN(v))) return true;
  return Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

/** The spans inside a paragraph that are formatted like a hyperlink (colored + underlined). */
function linkStyledSpans(p: Element): HTMLElement[] {
  return [...p.querySelectorAll("span")].filter((span) => {
    const s = getComputedStyle(span);
    return s.textDecorationLine.includes("underline") && !isNeutral(s.color);
  });
}

/** Send external links to a new tab so following one can't discard the app. */
function hardenExternalLinks(host: HTMLElement): void {
  for (const a of host.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#") || href === "") continue;
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
}

/**
 * Pair link-styled paragraphs with their text twin elsewhere in the document and mark both ends.
 * Returns how many entries were wired.
 */
function synthesizeTocLinks(host: HTMLElement): number {
  const byText = new Map<string, Element[]>();
  for (const p of host.querySelectorAll("p")) {
    if (p.querySelector("a")) continue; // the document already has a real link here
    const key = normalize(p.textContent ?? "");
    if (key.length < MIN_ENTRY_CHARS) continue;
    const group = byText.get(key);
    if (group) group.push(p);
    else byText.set(key, [p]);
  }

  let wired = 0;
  for (const group of byText.values()) {
    // Exactly two occurrences: the entry and its section. Three or more is ambiguous — skip it.
    if (group.length !== 2) continue;
    const styled = group.map(linkStyledSpans);
    // Exactly one end must look like a link, or there's no telling which way the jump goes.
    const from = styled[0].length > 0 ? 0 : 1;
    if (styled[from].length === 0 || styled[1 - from].length > 0) continue;

    const key = String(++wired);
    (group[1 - from] as HTMLElement).dataset.docxAnchor = key;
    for (const span of styled[from]) {
      span.dataset.docxJump = key;
      span.setAttribute("role", "link");
      span.setAttribute("tabindex", "0");
      span.title = "Jump to this section";
      span.classList.add("docx-synth-link");
    }
  }
  return wired;
}

let flashTimer: number | undefined;

/**
 * Scroll a section to the top of the preview and flash it briefly, so the eye finds the landing
 * spot. Shared by the in-document links and the table-of-contents panel.
 */
export function jumpToDocxSection(target: HTMLElement): void {
  // Smooth only when it will actually animate: a hidden tab (or reduced-motion) never runs the
  // animation, and the scroll would silently do nothing.
  const animate =
    document.visibilityState === "visible" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: animate ? "smooth" : "auto", block: "start" });
  window.clearTimeout(flashTimer);
  target.classList.remove("docx-jump-flash");
  void target.offsetWidth; // restart the animation when jumping to the same place twice
  target.classList.add("docx-jump-flash");
  flashTimer = window.setTimeout(() => target.classList.remove("docx-jump-flash"), FLASH_MS);
}

/** One section of a rendered document, for the table-of-contents panel. */
export interface DocxOutlineEntry {
  id: string;
  label: string;
  level: number;
  el: HTMLElement;
}

/** Heading depth from a leading section number: "3." → 1, "3.2" → 2, "3.2.1" → 3. */
function levelFromNumbering(text: string): number {
  const prefix = text.trim().match(/^\d+(?:\.\d+)*/);
  return prefix ? Math.min(6, prefix[0].split(".").filter(Boolean).length) : 1;
}

/**
 * The document's outline, in document order. Two sources, in order of trust:
 *
 *  1. Paragraphs using Word's built-in Heading styles — docx-preview renders those with a
 *     `docx_heading{N}` class, which gives both the section and its depth.
 *  2. The sections {@link wireDocxLinks} paired with a table-of-contents entry. Documents that
 *     never use Heading styles (very common in generated files) still get a usable outline this
 *     way, since the pairing already established which paragraphs are sections.
 *
 * Call after {@link wireDocxLinks}, so source 2 is available.
 */
export function collectDocxOutline(host: HTMLElement): DocxOutlineEntry[] {
  const styled = [...host.querySelectorAll<HTMLElement>("[class*='heading']")].filter((el) =>
    /(?:^|\s)docx_heading[1-6](?:\s|$)/.test(el.className)
  );
  const source = styled.length
    ? styled.map((el) => ({
        el,
        level: Number(el.className.match(/docx_heading([1-6])/)?.[1] ?? 1),
      }))
    : [...host.querySelectorAll<HTMLElement>("[data-docx-anchor]")].map((el) => ({
        el,
        level: levelFromNumbering(el.textContent ?? ""),
      }));

  return source
    .map(({ el, level }, i) => ({
      id: `docx-section-${i}`,
      label: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      level,
      el,
    }))
    .filter((e) => e.label.length > 0);
}

/**
 * Wire up the rendered document. Call once per render, after docx-preview has filled `host`; the
 * returned function detaches the listeners (call it when re-rendering or unmounting).
 */
export function wireDocxLinks(host: HTMLElement): () => void {
  hardenExternalLinks(host);
  synthesizeTocLinks(host);

  // Resolve what a click/Enter landed on: a synthesized entry, or a real in-document anchor.
  const resolve = (from: EventTarget | null): HTMLElement | null => {
    if (!(from instanceof Element)) return null;
    const el = from.closest<HTMLElement>("[data-docx-jump], a[href^='#']");
    if (!el) return null;
    const key = el.dataset.docxJump;
    const selector = key
      ? `[data-docx-anchor="${CSS.escape(key)}"]`
      : `#${CSS.escape(el.getAttribute("href")!.slice(1))}`;
    return host.querySelector<HTMLElement>(selector);
  };

  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const target = resolve(e.target);
    if (!target) return;
    e.preventDefault(); // keep the anchor out of the app's URL
    jumpToDocxSection(target);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = resolve(e.target);
    if (!target) return;
    e.preventDefault();
    jumpToDocxSection(target);
  };

  host.addEventListener("click", onClick);
  host.addEventListener("keydown", onKeyDown);
  return () => {
    host.removeEventListener("click", onClick);
    host.removeEventListener("keydown", onKeyDown);
    window.clearTimeout(flashTimer);
  };
}
