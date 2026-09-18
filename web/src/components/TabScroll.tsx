import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The scrolling run of tabs in a session's tab bar: the pull requests it has open for review and the
 * files it has open, in one container.
 *
 * One container rather than one per kind, because they read as one row and should behave like one.
 * Two strips each with their own `overflow-x-auto` clip at their own edges and scroll independently,
 * so a bar with reviews and files on it had a seam partway along where one run ended and the next
 * began — tabs disappearing into the middle of the bar rather than off the end of it, and a wheel
 * over one half moving only that half.
 *
 * The controls that belong to a run — the PR picker, the button that closes every file tab — stay
 * outside it on purpose: they are how you act on the row, and a row you have scrolled to the end of
 * should not have hidden the way back.
 */
export function TabScroll({
  revealOn,
  className,
  children,
}: {
  /**
   * Changes whenever the tab holding the pane changes, or the tabs move. Scrolling that tab back
   * into view is keyed on it — the container cannot watch its own children for that.
   */
  revealOn: string;
  className?: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Translate a vertical wheel into horizontal scrolling, so a crowded bar scrolls the way it looks
  // like it should. A native non-passive listener, because React's onWheel is passive and therefore
  // cannot preventDefault.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return; // nothing to scroll sideways
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the tab that owns the pane in view. `aria-selected` first: with two kinds of tab in here,
  // several can be their own kind's current one at once, but only one of them is the surface being
  // looked at. A view with no tab of its own showing — the tree, the terminal — has none, and then
  // the file merely marked as current is the next best thing to keep on screen.
  useEffect(() => {
    const el = scrollRef.current;
    const active =
      el?.querySelector<HTMLElement>('[aria-selected="true"]') ??
      el?.querySelector<HTMLElement>('[data-current="true"]');
    if (!el || !active) return;
    const c = el.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    const pad = 8;
    let target = el.scrollLeft;
    if (a.left < c.left) target -= c.left - a.left + pad;
    else if (a.right > c.right) target += a.right - c.right + pad;
    // Only ever the container's own scrollLeft — never the page, which scrollIntoView would move.
    if (target !== el.scrollLeft) el.scrollTo({ left: target, behavior: "smooth" });
  }, [revealOn]);

  return (
    <div
      ref={scrollRef}
      className={cn("hover-scrollbar flex h-full min-w-0 flex-1 items-stretch overflow-x-auto", className)}
    >
      {children}
    </div>
  );
}
