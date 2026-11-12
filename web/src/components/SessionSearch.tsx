import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionInfo } from "@/types";
import { recentLabel, type RecentSession } from "@/lib/recentSessions";
import { sessionColor } from "@/lib/sessionColors";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Radio, Search, Terminal } from "lucide-react";

/** Split a query into lowercase terms; every term must match somewhere for a row to be a hit. */
function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * A row's searchable fields as one lowercase string. Fields are joined with a newline so a term can't
 * match across two of them (e.g. the end of a name plus the start of a path).
 */
function haystack(fields: (string | null | undefined)[]): string {
  return fields.filter(Boolean).join("\n").toLowerCase();
}

/** Whether all terms appear in a row's haystack. */
function matches(tokens: string[], hay: string): boolean {
  return tokens.every((t) => hay.includes(t));
}

/**
 * Rows rendered at a time; more are added as the list is scrolled to its end. With hundreds of sessions
 * and recents, rendering every hit made each keystroke (and each hover, which moves the highlight) slow.
 */
const PAGE = 50;

/** A search hit: either a live session or a recent launch preset. */
type Hit =
  | { kind: "session"; session: SessionInfo }
  | { kind: "recent"; recent: RecentSession };

/**
 * What the highlight follows: a session by its id, a recent by its place among the recents. Not an index
 * into the rows, which shift under it whenever another page of sessions is rendered above the recents.
 */
const sessionHitKey = (s: SessionInfo) => `s:${s.id}`;
const recentHitKey = (i: number) => `r:${i}`;

/** The most of a field a row renders: each is one truncated line, so the rest would never show. */
const SHOWN_CHARS = 200;

/**
 * Cuts a long field down to what a row can show. A recent's prompt can run to thousands of characters,
 * and marking every hit of a one-letter query across all of them meant tens of thousands of elements per
 * keystroke. When the first hit lies past what would show, the cut starts just before it instead, so the
 * row still shows why it matched.
 */
function clip(text: string, tokens: string[]): string {
  if (text.length <= SHOWN_CHARS) return text;
  const lower = text.toLowerCase();
  const first = Math.min(...tokens.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  if (!Number.isFinite(first) || first < SHOWN_CHARS / 2) return text.slice(0, SHOWN_CHARS);
  return "…" + text.slice(first - 20, first - 20 + SHOWN_CHARS);
}

/** Renders `text` with every occurrence of any search term marked. */
function Highlight({ text: full, tokens }: { text: string; tokens: string[] }) {
  const text = full && clip(full, tokens);
  if (tokens.length === 0 || !text) return <>{text}</>;
  const lower = text.toLowerCase();
  // Mark the characters covered by any term, then emit alternating plain/marked runs — this keeps
  // overlapping terms ("cla claude") from producing nested or duplicated marks.
  const hit = new Array<boolean>(text.length).fill(false);
  for (const t of tokens) {
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + 1)) {
      for (let j = i; j < i + t.length; j++) hit[j] = true;
    }
  }
  const parts: ReactNode[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || hit[i] !== hit[start]) {
      const chunk = text.slice(start, i);
      parts.push(
        hit[start] ? (
          <mark key={start} className="rounded bg-amber-300/50 text-inherit dark:bg-amber-400/30">
            {chunk}
          </mark>
        ) : (
          <span key={start}>{chunk}</span>
        )
      );
      start = i;
    }
  }
  return <>{parts}</>;
}

/** Small uppercase divider above each result section. */
function SectionLabel({ children, count }: { children: ReactNode; count: number }) {
  return (
    <div className="flex items-center gap-2 px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      <span>{children}</span>
      <span className="rounded bg-muted px-1">{count}</span>
    </div>
  );
}

const rowClass = (active: boolean) =>
  cn(
    "flex w-full cursor-pointer flex-col gap-1 rounded-md px-2.5 py-2 text-left text-sm",
    active && "bg-accent"
  );

/**
 * One live session's row. Memoized, with stable callbacks from the dialog, so moving the highlight
 * re-renders only the two rows it moves between rather than the whole list.
 */
const SessionRow = memo(function SessionRow({
  session: s,
  hitKey,
  tokens,
  active,
  current,
  nodeName,
  onHover,
  onActivate,
}: {
  session: SessionInfo;
  hitKey: string;
  tokens: string[];
  active: boolean;
  current: boolean;
  /** The machine's name for a peer's session; null for this machine's. */
  nodeName: string | null;
  onHover: (hitKey: string) => void;
  onActivate: (h: Hit) => void;
}) {
  const color = sessionColor(s.color);
  const restorable = s.state === "Restorable";
  return (
    <div
      data-hit={hitKey}
      role="button"
      tabIndex={-1}
      onMouseEnter={() => onHover(hitKey)}
      onClick={() => onActivate({ kind: "session", session: s })}
      className={rowClass(active)}
      title={restorable ? "Open this closed session — files, diff, and Reopen" : "Open this session"}
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            s.state === "Running" ? "bg-emerald-500" : "bg-muted-foreground/40"
          )}
          style={color ? { backgroundColor: color } : undefined}
        />
        <span className={cn("truncate font-medium", s.state !== "Running" && "text-muted-foreground")}>
          <Highlight text={s.name} tokens={tokens} />
        </span>
        {s.remoteControl && (
          <Radio className="size-3 shrink-0 text-muted-foreground" aria-label="remote control" />
        )}
        {current && (
          <Badge variant="secondary" className="shrink-0">
            current
          </Badge>
        )}
        {/* What the row is, not what activating it does — that is "open", the same as
            every other row here. The word matches the badge the session header shows
            and the sidebar's own tooltip, so one state has one name. */}
        {restorable && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">closed</span>}
      </div>
      <span className="truncate pl-3.5 font-mono text-[10px] text-muted-foreground">
        {nodeName !== null && (
          <>
            <Highlight text={nodeName} tokens={tokens} />
            {" · "}
          </>
        )}
        <Highlight text={s.workingDirectory} tokens={tokens} />
      </span>
    </div>
  );
});

/** One recent launch preset's row; memoized for the same reason as SessionRow. */
const RecentRow = memo(function RecentRow({
  recent: r,
  hitKey,
  tokens,
  active,
  onHover,
  onActivate,
}: {
  recent: RecentSession;
  hitKey: string;
  tokens: string[];
  active: boolean;
  onHover: (hitKey: string) => void;
  onActivate: (h: Hit) => void;
}) {
  return (
    <div
      data-hit={hitKey}
      role="button"
      tabIndex={-1}
      onMouseEnter={() => onHover(hitKey)}
      onClick={() => onActivate({ kind: "recent", recent: r })}
      className={rowClass(active)}
      title="Adjust and create a session from this preset"
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate font-medium">
          <Highlight text={recentLabel(r)} tokens={tokens} />
        </span>
        <Badge variant="secondary" className="shrink-0 capitalize">
          {r.model || "default"}
        </Badge>
        {r.remoteControl && (
          <Radio className="size-3 shrink-0 text-muted-foreground" aria-label="remote control" />
        )}
      </div>
      {r.command && (
        <span className="flex items-start gap-1 truncate text-[10px] text-muted-foreground">
          <Terminal className="mt-0.5 size-2.5 shrink-0" />
          <span className="truncate">
            <Highlight text={r.command} tokens={tokens} />
          </span>
        </span>
      )}
      <span className="truncate font-mono text-[10px] text-muted-foreground">
        <Highlight text={r.workingDirectory} tokens={tokens} />
      </span>
    </div>
  );
});

/**
 * Search popup over the sidebar's two lists: live sessions and recent launch presets. Matching is a
 * plain all-terms substring search over exactly the fields each row shows, so every hit is visibly
 * explained by the highlighting. Activating a hit opens the session — a closed one included, on its
 * files, with the button that reopens it where the terminal would be — or, for a recent preset,
 * opens the New Session dialog prefilled from it. Either way the popup closes.
 *
 * The sessions are every machine's: a peer's carry their `nodeId`, are found by its name too, and say
 * which machine they are on. Each session's `id` here is its sessionKey, which is what `onSelect` gets.
 */
export function SessionSearchDialog({
  sessions,
  nodeNames,
  recents,
  activeId,
  onSelect,
  onReuse,
  onClose,
}: {
  sessions: SessionInfo[];
  /** The peers' names, by node id. */
  nodeNames?: Record<string, string>;
  recents: RecentSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onReuse: (r: RecentSession) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // The highlighted row's hit key; null for the first row.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const listRef = useRef<HTMLDivElement>(null);
  // A state ref rather than useRef: the dialog's portal mounts its content a render after this one,
  // so the observer below has to run again once the row exists.
  const [moreEl, setMoreEl] = useState<HTMLDivElement | null>(null);

  // The haystacks are built once per list rather than on every keystroke.
  const sessionIndex = useMemo(
    () =>
      sessions.map((s) => ({
        s,
        hay: haystack([s.name, s.workingDirectory, s.nodeId ? nodeNames?.[s.nodeId] : null]),
      })),
    [sessions, nodeNames]
  );
  const recentIndex = useMemo(
    () =>
      recents.map((r) => ({
        r,
        hay: haystack([recentLabel(r), r.name, r.workingDirectory, r.command, r.model]),
      })),
    [recents]
  );

  const tokens = useMemo(() => tokenize(query), [query]);
  const sessionHits = useMemo(
    () => sessionIndex.filter((x) => matches(tokens, x.hay)).map((x) => x.s),
    [sessionIndex, tokens]
  );
  const recentHits = useMemo(
    () => recentIndex.filter((x) => matches(tokens, x.hay)).map((x) => x.r),
    [recentIndex, tokens]
  );
  // Only the first `limit` hits — sessions, then recents — are rendered (and reachable by the arrows);
  // the rest come in as the list is scrolled to its end.
  const shownSessions = useMemo(() => sessionHits.slice(0, limit), [sessionHits, limit]);
  const shownRecents = useMemo(
    () => recentHits.slice(0, Math.max(0, limit - sessionHits.length)),
    [recentHits, limit, sessionHits.length]
  );
  const total = sessionHits.length + recentHits.length;
  const hidden = total - shownSessions.length - shownRecents.length;
  const hits: (Hit & { key: string })[] = useMemo(
    () => [
      ...shownSessions.map((session) => ({ kind: "session" as const, session, key: sessionHitKey(session) })),
      ...shownRecents.map((recent, i) => ({ kind: "recent" as const, recent, key: recentHitKey(i) })),
    ],
    [shownSessions, shownRecents]
  );

  // The highlighted row: the first when nothing is, or when the one that was has left the list.
  const cursor = hits.length === 0 ? -1 : Math.max(0, hits.findIndex((h) => h.key === activeKey));
  const cursorKey = cursor >= 0 ? hits[cursor].key : null;

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    if (cursorKey === null) return;
    listRef.current?.querySelector(`[data-hit="${CSS.escape(cursorKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursorKey]);

  // Render the next page once scrolling brings the end of the list near (the arrows extend it
  // themselves, in onKeyDown). Re-observed after each page, so a page that still leaves the end in view
  // is followed straight away by the next.
  useEffect(() => {
    if (!moreEl) return;
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && setLimit((l) => l + PAGE),
      { root: listRef.current, rootMargin: "200px" }
    );
    io.observe(moreEl);
    return () => io.disconnect();
  }, [moreEl, limit]);

  // The rows take these as stable callbacks, so they stay memoized while the parent's props change.
  const propsRef = useRef({ onClose, onSelect, onReuse });
  propsRef.current = { onClose, onSelect, onReuse };
  const activate = useCallback((h: Hit) => {
    const { onClose, onSelect, onReuse } = propsRef.current;
    onClose();
    if (h.kind === "recent") onReuse(h.recent);
    else onSelect(h.session.id);
  }, []);

  function onQueryChange(q: string) {
    setQuery(q);
    setActiveKey(null);
    setLimit(PAGE);
    // Back to the top, where the cursor is — a list scrolled down a later page would otherwise leave it
    // off-screen, as scrolling into view only follows a cursor that moves.
    listRef.current?.scrollTo({ top: 0 });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      // Off the last shown row, on to the next one rather than back round to the first.
      if (cursor === hits.length - 1 && hidden > 0) {
        const next = cursor + 1;
        setLimit((l) => l + PAGE);
        setActiveKey(
          next < sessionHits.length
            ? sessionHitKey(sessionHits[next])
            : recentHitKey(next - sessionHits.length)
        );
      } else if (hits.length) setActiveKey(hits[(cursor + 1) % hits.length].key);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      if (hits.length) setActiveKey(hits[(cursor + hits.length - 1) % hits.length].key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor >= 0) activate(hits[cursor]);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="top-[10%] max-w-xl translate-y-0 gap-0 p-0"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">Search sessions</DialogTitle>
        <DialogDescription className="sr-only">
          Search live sessions and recent session presets by name, folder or prompt.
        </DialogDescription>

        <div className="relative border-b p-2 pr-10">
          <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search sessions and recents…"
            className="border-0 pl-8 shadow-none focus-visible:ring-0"
            spellCheck={false}
          />
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-auto px-1 pb-2">
          {total === 0 && (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              {sessions.length === 0 && recents.length === 0
                ? "Nothing to search yet"
                : `No sessions or recents match “${query.trim()}”`}
            </p>
          )}

          {sessionHits.length > 0 && (
            <>
              <SectionLabel count={sessionHits.length}>Sessions</SectionLabel>
              {shownSessions.map((s, i) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  hitKey={sessionHitKey(s)}
                  tokens={tokens}
                  active={i === cursor}
                  current={s.id === activeId}
                  nodeName={s.nodeId ? (nodeNames?.[s.nodeId] ?? "another machine") : null}
                  onHover={setActiveKey}
                  onActivate={activate}
                />
              ))}
            </>
          )}

          {shownRecents.length > 0 && (
            <>
              <SectionLabel count={recentHits.length}>Recent</SectionLabel>
              {shownRecents.map((r, i) => {
                return (
                  <RecentRow
                    key={i}
                    recent={r}
                    hitKey={recentHitKey(i)}
                    tokens={tokens}
                    active={shownSessions.length + i === cursor}
                    onHover={setActiveKey}
                    onActivate={activate}
                  />
                );
              })}
            </>
          )}

          {hidden > 0 && (
            <div ref={setMoreEl} className="px-3 py-2 text-center text-[10px] text-muted-foreground">
              {hidden} more — scroll, or type to narrow
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span>
            {total} result{total === 1 ? "" : "s"}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
