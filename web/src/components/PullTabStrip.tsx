import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitHubPull, SessionPull, SessionRepo } from "@/types";
import { age } from "@/lib/age";
import { pullKey, pullTabLabel } from "@/lib/sessionPulls";
import { useSessionRepos } from "@/lib/sessionRepos";
import { useDismissable } from "@/lib/useDismissable";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Library,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useApi } from "@/lib/node";

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

/** Where a repo in the strip came from, said on hover — it is also what can be unlinked there. */
const SOURCE_TITLE: Record<SessionRepo["source"], string> = {
  folder: "The repository this session's folder points at",
  session: "Linked to this session",
  project: "Linked to this session's project",
};

/** Cache key for a listing: which repo, in which state. Both are picked in the popup. */
const listingKey = (repo: string, state: PullState) => `${repo}\u0000${state}`;

/** The icon GitHub uses for a PR's state, which is how a row is read before its text is. */
function stateIcon(pull: GitHubPull) {
  if (pull.state === "MERGED") return { Icon: GitMerge, className: "text-violet-500" };
  if (pull.state === "CLOSED") return { Icon: GitPullRequestClosed, className: "text-red-500" };
  if (pull.draft) return { Icon: GitPullRequestDraft, className: "text-muted-foreground" };
  return { Icon: GitPullRequest, className: "text-emerald-500" };
}

/**
 * The pull requests a session has open as tabs, and the button that picks another one out of a repo.
 * It sits right after Files, because a PR is a view of the same repo the tree below it is showing —
 * the review and the working copy one click apart.
 *
 * A session can reach more than one repo: its own folder's, whatever has been linked to the folder
 * here, and whatever its project names (see lib/sessionRepos.ts). So the popup picks a repo as well
 * as a PR, and is where a repo is linked — the list behind it comes from the gh CLI, which answers
 * for any repo by name as whoever is signed into it, so a linked repo needs no checkout.
 *
 * The button is only in the tab bar when there is a repo to review. A session with none — a folder
 * opened a level up over several checkouts, say — reaches the popup through "Pull request…" in the
 * "+" menu, which is what `openSignal` is, and links its first repo from there.
 */
export function PullPicker({
  sessionId,
  onOpen,
  atEnd = false,
  openSignal = 0,
}: {
  sessionId: string;
  /** The button ends a split group's strip: the list hangs back to the left from its right edge. */
  atEnd?: boolean;
  /** Bumped to open the list from elsewhere — the "+" menu of the group the picker sits in. */
  openSignal?: number;
  onOpen: (pull: SessionPull) => void;
}) {
  const api = useApi();
  const [menuOpen, setMenuOpen] = useState(false);
  const [state, setState] = useState<PullState>("open");
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  // The repos this session can review, and which of them is being listed. The list is shared with
  // every other picker on screen, so a repo linked in one group's popup is in the next one's.
  const repos = useSessionRepos(sessionId);
  const [chosen, setChosen] = useState<string>("");
  // The "link a repo" row, unfolded by the + beside the repo strip, and why the last name typed
  // into it was refused. Both belong to the popup rather than to the session, so both go when it
  // closes — a typo is not something to be told about again the next time you open the list.
  const [linking, setLinking] = useState(false);
  const [newRepo, setNewRepo] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);
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
    setChosen("");
    setLinking(false);
    setLinkError(null);
  }, [sessionId]);

  // The repo being listed: whichever was picked, or the first the server offered — its own folder's
  // when it has one, since that is the repo the session is working in. A repo that has been unlinked
  // under us falls back the same way.
  const names = useMemo(() => repos.repos.map((r) => r.nameWithOwner), [repos.repos]);
  const repo = chosen && names.includes(chosen) ? chosen : names[0] ?? "";

  const load = useCallback(
    async (which: PullState, from: string, force: boolean) => {
      if (!from) return; // no repo to ask about yet — the popup says so rather than fetching
      const key = listingKey(from, which);
      if (!force && listingsRef.current[key]) return;
      setLoading(true);
      try {
        const res = await api.githubPulls(sessionId, which, from);
        setListings((prev) => ({
          ...prev,
          [key]: res.error ? { error: res.error } : { pulls: res.pulls },
        }));
      } catch {
        setListings((prev) => ({ ...prev, [key]: { error: "Could not reach the server." } }));
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
  );

  // Fetch on open and whenever the repo or the state moves to a pair not yet loaded. A PR list is
  // live enough that opening the menu again is a reasonable time to ask — but only for what shows.
  useEffect(() => {
    if (menuOpen) void load(state, repo, false);
  }, [menuOpen, state, repo, load]);

  // Folding the link row away with the popup. It belongs to the popup rather than to the session,
  // so a half-typed name left behind by a click outside is not what the next open should show —
  // and while it is unfolded it takes the caret, which would cost the reader the type-to-filter
  // below on a popup they opened to look through a list.
  useEffect(() => {
    if (!menuOpen) {
      setLinking(false);
      setLinkError(null);
    }
  }, [menuOpen]);

  // Opened from the "+" menu beside it. Only a rise counts: the signal drops to 0 when another
  // group's picker is asked instead, and mounting at a non-zero value must not pop the list open.
  const seenSignal = useRef(openSignal);
  useEffect(() => {
    const rose = openSignal > seenSignal.current;
    seenSignal.current = openSignal;
    if (rose) setMenuOpen(true);
  }, [openSignal]);

  // Typing should filter without reaching for the box first: the list is the point of the popup —
  // except while a repo is being linked, where the box that was just unfolded wants the caret.
  useEffect(() => {
    if (!menuOpen) return;
    if (linking) linkRef.current?.focus();
    else filterRef.current?.focus();
  }, [menuOpen, linking]);

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

  const listing = repo ? listings[listingKey(repo, state)] : undefined;
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
    // The session's own repo is left off the tab: it is the common case, and a tab saved before
    // repos could be linked says nothing either — so both land on one tab rather than two (pullKey).
    const own = repos.repos.find((r) => r.source === "folder")?.nameWithOwner;
    onOpen({ number: pull.number, title: pull.title, repo: repo === own ? undefined : repo });
    setMenuOpen(false);
  };

  const link = async () => {
    if (!newRepo.trim()) return;
    const { name, error } = await repos.link(newRepo);
    if (error !== undefined) {
      setLinkError(error);
      return;
    }
    // Show what was just linked: linking a repo is on the way to reviewing it.
    setChosen(name);
    setNewRepo("");
    setLinking(false);
    setLinkError(null);
  };

  return (
    // In the place a view tab would be, and outside the scrolling run of tabs beside it: opening a
    // PR is choosing a surface, and the way to do it should not scroll off the bar.
    // The wrapper stays, empty, for a session with no repo: it is what the popup hangs off, and the
    // "+" menu can still open that popup — which is where the first repo gets linked.
    <div ref={menuRef} className="relative flex h-full shrink-0 items-stretch">
    <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        title="Pull requests on GitHub"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={cn(
          "flex h-full items-center gap-1.5 border-b-2 border-transparent text-sm font-medium transition-colors",
          atEnd ? "px-2" : "px-3",
          menuOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          // Nothing to review and nothing open: no button. It comes back the moment the popup is
          // opened from the "+" menu, so the list has something to hang under.
          names.length === 0 && !menuOpen && "hidden"
        )}
      >
        <GitPullRequest className="size-4" />
        <span className="hidden sm:inline">PRs</span>
        {!atEnd && <ChevronDown className="size-3.5" />}
      </button>

      {menuOpen && (
        <div
          role="menu"
          // At the end of a strip the list hangs back to the left from the button's right edge.
          style={{ maxWidth: atEnd ? "calc(100vw - 1rem)" : room }}
          className={cn(
            "absolute top-full z-30 mt-1 flex max-h-[70vh] w-[34rem] flex-col overflow-hidden rounded-md popover-edge bg-popover shadow-md",
            atEnd ? "right-0" : "left-0"
          )}
        >
          {/* Which repo is being listed, and where another is linked. Always shown, even for the one
              repo a session usually has: it is how the second one gets added. */}
          <div className="flex items-center gap-1 border-b px-1.5 py-1">
            <Library className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
              {names.length === 0 ? (
                <span className="px-1 text-xs text-muted-foreground">
                  {repos.loading ? "Looking…" : "No repository yet."}
                </span>
              ) : (
                repos.repos.map((r) => (
                  <span
                    key={r.nameWithOwner}
                    className={cn(
                      "group/repo flex shrink-0 items-center gap-1 rounded py-0.5 pl-1.5 pr-1 text-xs transition-colors",
                      r.nameWithOwner === repo
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setChosen(r.nameWithOwner)}
                      title={SOURCE_TITLE[r.source]}
                      className="max-w-[14rem] truncate"
                    >
                      {r.nameWithOwner}
                    </button>
                    {/* Only what this session linked can be unlinked here. Its folder's own repo is
                        a fact about the folder, and a project's is the project's to take back. */}
                    {r.source === "session" && (
                      <button
                        type="button"
                        onClick={() => void repos.unlink(r.nameWithOwner)}
                        title="Unlink this repository"
                        className="opacity-0 transition-opacity hover:text-destructive group-hover/repo:opacity-100"
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </span>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={() => setLinking((o) => !o)}
              title="Link another repository to this session"
              className={cn(
                "shrink-0 rounded p-1 hover:bg-accent hover:text-foreground",
                linking ? "text-foreground" : "text-muted-foreground"
              )}
            >
              <Plus className="size-3.5" />
            </button>
          </div>

          {linking && (
            <div className="flex items-center gap-2 border-b px-1.5 py-1.5">
              <input
                ref={linkRef}
                value={newRepo}
                onChange={(e) => {
                  setNewRepo(e.target.value);
                  setLinkError(null); // typing is the answer to being told it was wrong
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void link();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setLinking(false);
                  }
                }}
                placeholder="owner/name, or a link to the repository on GitHub"
                className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => void link()}
                disabled={!newRepo.trim()}
                className="shrink-0 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                Link
              </button>
            </div>
          )}

          {(linkError ?? repos.error) && (
            <div
              className={cn(
                "border-b px-2.5 py-1.5 text-xs",
                linkError ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {linkError ?? repos.error}
            </div>
          )}

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
              onClick={() => {
                repos.reload();
                void load(state, repo, true);
              }}
              title="Reload from GitHub"
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {!repo ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                {repos.loading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" /> Looking for this session's
                    repositories…
                  </span>
                ) : repos.error ? (
                  // Whatever went wrong is already said above the strip; repeating it here, or
                  // guessing at "no remote", would be putting words to something we do not know.
                  "This session's repositories could not be read."
                ) : (
                  <>
                    This session has no GitHub repository.
                    <div className="mt-1 text-xs">
                      Its folder has no GitHub remote. Link a repository with the + above to review
                      its pull requests from here — a session can reach any repository, checked out
                      or not.
                    </div>
                  </>
                )}
              </div>
            ) : listing === undefined ? (
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
  activeKey,
  showingPull,
  onActivate,
  onClose,
}: {
  pulls: SessionPull[];
  /** The key (pullKey) of the review the pane is on, whether or not it is the surface showing. */
  activeKey: string | null;
  /** Whether a PR is the surface currently showing, as opposed to open but behind another tab. */
  showingPull: boolean;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
}) {
  return (
    <>
      {pulls.map((p) => {
        const key = pullKey(p);
        const current = key === activeKey;
        const active = current && showingPull;
        return (
          <div
            key={key}
            role="tab"
            aria-selected={active}
            data-current={current}
            title={pullTabLabel(p)}
            onClick={() => onActivate(key)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(key);
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
            {/* A review of another repo says which, since the number alone would be two reviews
                looking like one. The session's own repo goes unsaid — it is everything else here. */}
            {p.repo && (
              <span className="max-w-[7rem] truncate text-xs text-muted-foreground">
                {p.repo.split("/")[1] ?? p.repo}
              </span>
            )}
            <span className="shrink-0 text-xs text-muted-foreground">#{p.number}</span>
            <span className="max-w-[10rem] truncate">{p.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(key);
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
