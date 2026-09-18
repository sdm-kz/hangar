import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitHubPull, SessionPull } from "@/types";
import { api } from "@/lib/api";
import { pullTabLabel } from "@/lib/sessionPulls";
import { useDismissable } from "@/lib/useDismissable";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

/** Which pull requests the picker is listing. Open is the default — it is what a session is for. */
type PullState = "open" | "closed" | "all";

const STATES: { id: PullState; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

/** A loaded list, or what went wrong loading it. Kept per state so switching back is instant. */
interface Listing {
  pulls?: GitHubPull[];
  error?: string;
}

/** The icon GitHub uses for a PR's state, which is how a row is read before its text is. */
function stateIcon(pull: GitHubPull) {
  if (pull.state === "MERGED") return { Icon: GitMerge, className: "text-violet-500" };
  if (pull.state === "CLOSED") return { Icon: GitPullRequestClosed, className: "text-red-500" };
  if (pull.draft) return { Icon: GitPullRequestDraft, className: "text-muted-foreground" };
  return { Icon: GitPullRequest, className: "text-emerald-500" };
}

/** Coarse age — the point is "hours vs days", not precision. */
function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = ms / 60000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  const days = Math.round(minutes / 1440);
  return days < 60 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

/**
 * The pull requests a session has open, as tabs in its tab bar, and the button that picks another
 * one out of the repo. It sits right after Files, because a PR is a view of the same repo the tree
 * below it is showing — the review and the working copy one click apart.
 *
 * The button only exists for a session whose folder is a GitHub repo (SessionView asks the server,
 * which reads the git remote). The list behind it comes from the gh CLI, so it is the PRs of
 * whichever repo that folder's remote points at, seen as whoever is signed into gh.
 */
export function PullPicker({
  sessionId,
  enabled,
  onOpen,
}: {
  sessionId: string;
  /**
   * Offer the picker at all. False while the folder is not known to be a GitHub repo — reviews
   * opened earlier (or on another device) still have their tabs, which are saved state and stay
   * reachable whatever the repo probe has to say.
   */
  enabled: boolean;
  onOpen: (pull: SessionPull) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [state, setState] = useState<PullState>("open");
  const [listings, setListings] = useState<Partial<Record<PullState, Listing>>>({});
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  // How much room is left between the button and the right edge of the window. The picker hangs off
  // the button's left edge — which is where it belongs, under the thing that opened it — and the
  // button sits partway along the tab bar, so on a narrow window the list would otherwise run off
  // the screen with the change counts on the far side of the edge.
  const [room, setRoom] = useState<number>();
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const menuRef = useDismissable<HTMLDivElement>(menuOpen, closeMenu);
  const filterRef = useRef<HTMLInputElement>(null);
  // What is already loaded, where the fetch can read it without depending on it — the alternative is
  // a `load` that changes identity on every answer and an effect that chases it.
  const listingsRef = useRef(listings);
  listingsRef.current = listings;

  // Anything cached belongs to the session it was fetched for.
  useEffect(() => {
    setListings({});
    setFilter("");
  }, [sessionId]);

  const load = useCallback(
    async (which: PullState, force: boolean) => {
      if (!force && listingsRef.current[which]) return;
      setLoading(true);
      try {
        const res = await api.githubPulls(sessionId, which);
        setListings((prev) => ({
          ...prev,
          [which]: res.error ? { error: res.error } : { pulls: res.pulls },
        }));
      } catch {
        setListings((prev) => ({ ...prev, [which]: { error: "Could not reach the server." } }));
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
  );

  // Fetch on open and whenever the state filter moves to one not yet loaded. A PR list is live
  // enough that opening the menu again is a reasonable time to ask — but only for what is showing.
  useEffect(() => {
    if (menuOpen) void load(state, false);
  }, [menuOpen, state, load]);

  // The picker can go away under an open menu — a session switch, a probe that came back negative.
  useEffect(() => {
    if (!enabled) setMenuOpen(false);
  }, [enabled]);

  // Typing should filter without reaching for the box first: the list is the point of the popup.
  useEffect(() => {
    if (menuOpen) filterRef.current?.focus();
  }, [menuOpen]);

  // Measure the room to the right on open, and keep measuring while it is open: a window resize
  // moves the button, and the picker is tall enough to be worth getting right rather than closing.
  useEffect(() => {
    if (!menuOpen) return;
    const measure = () => {
      const left = menuRef.current?.getBoundingClientRect().left ?? 0;
      setRoom(Math.max(240, window.innerWidth - left - 8));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [menuOpen, menuRef]);

  const listing = listings[state];
  const shown = useMemo(() => {
    const all = listing?.pulls ?? [];
    // "#42" is how a pull request is written down everywhere else, so the hash is dropped rather
    // than searched for: it appears in none of the fields, and left in it matches nothing at all.
    const q = filter.trim().replace(/^#/, "").toLowerCase();
    if (!q) return all;
    // The number counts as text here, so "42" finds #142 as well as #42.
    return all.filter(
      (p) =>
        String(p.number).includes(q) ||
        p.title.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q) ||
        p.headRefName.toLowerCase().includes(q)
    );
  }, [listing, filter]);

  const pick = (pull: GitHubPull) => {
    onOpen({ number: pull.number, title: pull.title });
    setMenuOpen(false);
  };

  return (
    // In the place a view tab would be, and outside the scrolling run of tabs beside it: opening a
    // PR is choosing a surface, and the way to do it should not scroll off the bar.
    <div ref={menuRef} className={cn("relative flex h-full shrink-0 items-stretch", !enabled && "hidden")}>
    <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        title="Pull requests on GitHub"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={cn(
          "flex h-full items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium transition-colors",
          menuOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        )}
      >
        <GitPullRequest className="size-4" />
        <span className="hidden sm:inline">PRs</span>
        <ChevronDown className="size-3.5" />
      </button>

      {menuOpen && (
        <div
          role="menu"
          style={{ maxWidth: room }}
          className="absolute left-0 top-full z-30 mt-1 flex max-h-[70vh] w-[34rem] flex-col overflow-hidden rounded-md popover-edge bg-popover shadow-md"
        >
          <div className="flex items-center gap-1 border-b p-1.5">
            {STATES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setState(s.id)}
                className={cn(
                  "rounded px-2 py-1 text-xs font-medium transition-colors",
                  state === s.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {s.label}
              </button>
            ))}
            <div className="relative ml-1 min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={filterRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by number, title, author or branch"
                className="h-7 w-full rounded border bg-background pl-7 pr-2 text-xs outline-none focus:border-primary"
              />
            </div>
            <button
              type="button"
              onClick={() => void load(state, true)}
              title="Reload from GitHub"
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {listing === undefined ? (
              <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Asking GitHub…
              </div>
            ) : listing.error ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                {listing.error}
                <div className="mt-1 text-xs">
                  Pull requests are read through the GitHub CLI — <code>gh auth login</code> on the
                  server machine is what signs it in.
                </div>
              </div>
            ) : shown.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                {listing.pulls?.length
                  ? "No pull request matches that."
                  : state === "open"
                    ? "No open pull requests."
                    : "No pull requests."}
              </div>
            ) : (
              shown.map((p) => {
                const { Icon, className } = stateIcon(p);
                const updated = age(p.updatedAt);
                return (
                  <button
                    key={p.number}
                    role="menuitem"
                    onClick={() => pick(p)}
                    title={`${p.headRefName} → ${p.baseRefName}`}
                    className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
                  >
                    <Icon className={cn("mt-0.5 size-4 shrink-0", className)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="shrink-0 text-xs text-muted-foreground">#{p.number}</span>
                        <span className="min-w-0 flex-1 truncate text-sm">{p.title}</span>
                      </span>
                      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{p.author}</span>
                        <span className="truncate">{p.headRefName}</span>
                        {updated && <span className="shrink-0">{updated}</span>}
                      </span>
                    </span>
                    <span className="mt-0.5 shrink-0 font-mono text-xs">
                      <span className="text-emerald-600 dark:text-emerald-400">+{p.additions}</span>{" "}
                      <span className="text-red-600 dark:text-red-400">−{p.deletions}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The open reviews, as tabs of the same standing as the files beside them. Rendered into the tab
 * bar's shared scroller (see TabScroll) rather than into a strip of its own, so the reviews and the
 * open files are one run of tabs with one scrollbar.
 */
export function PullTabs({
  pulls,
  activeNumber,
  showingPull,
  onActivate,
  onClose,
}: {
  pulls: SessionPull[];
  activeNumber: number | null;
  /** Whether a PR is the surface currently showing, as opposed to open but behind another tab. */
  showingPull: boolean;
  onActivate: (number: number) => void;
  onClose: (number: number) => void;
}) {
  return (
    <>
      {pulls.map((p) => {
        const current = p.number === activeNumber;
        const active = current && showingPull;
        return (
          <div
            key={p.number}
            role="tab"
            aria-selected={active}
            data-current={current}
            title={pullTabLabel(p)}
            onClick={() => onActivate(p.number)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(p.number);
              }
            }}
            className={cn(
              "group/pull flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-b-2 pl-3 pr-2 text-sm font-medium transition-colors",
              active
                ? "border-primary text-foreground"
                : current
                  ? "border-border text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <GitPullRequest className="size-4 shrink-0" />
            <span className="shrink-0 text-xs text-muted-foreground">#{p.number}</span>
            <span className="max-w-[10rem] truncate">{p.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(p.number);
              }}
              title="Close this review"
              className={cn(
                "rounded p-0.5 hover:bg-accent hover:text-foreground",
                current ? "opacity-100" : "opacity-0 group-hover/pull:opacity-100"
              )}
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </>
  );
}
