import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
 * Whether all terms appear in the row's searchable fields. Fields are joined with a newline so a term
 * can't match across two of them (e.g. the end of a name plus the start of a path).
 */
function matches(tokens: string[], fields: (string | null | undefined)[]): boolean {
  if (tokens.length === 0) return true;
  const hay = fields.filter(Boolean).join("\n").toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/** A search hit: either a live session or a recent launch preset. */
type Hit =
  | { kind: "session"; session: SessionInfo }
  | { kind: "recent"; recent: RecentSession };

/** Renders `text` with every occurrence of any search term marked. */
function Highlight({ text, tokens }: { text: string; tokens: string[] }) {
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

/**
 * Search popup over the sidebar's two lists: live sessions and recent launch presets. Matching is a
 * plain all-terms substring search over exactly the fields each row shows, so every hit is visibly
 * explained by the highlighting. Activating a hit opens the session — a closed one included, on its
 * files, with the button that reopens it where the terminal would be — or, for a recent preset,
 * opens the New Session dialog prefilled from it. Either way the popup closes.
 */
export function SessionSearchDialog({
  sessions,
  recents,
  activeId,
  onSelect,
  onReuse,
  onClose,
}: {
  sessions: SessionInfo[];
  recents: RecentSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onReuse: (r: RecentSession) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const tokens = useMemo(() => tokenize(query), [query]);
  const sessionHits = useMemo(
    () => sessions.filter((s) => matches(tokens, [s.name, s.workingDirectory])),
    [sessions, tokens]
  );
  const recentHits = useMemo(
    () =>
      recents.filter((r) =>
        matches(tokens, [recentLabel(r), r.name, r.workingDirectory, r.command, r.model])
      ),
    [recents, tokens]
  );
  const hits: Hit[] = useMemo(
    () => [
      ...sessionHits.map((session) => ({ kind: "session" as const, session })),
      ...recentHits.map((recent) => ({ kind: "recent" as const, recent })),
    ],
    [sessionHits, recentHits]
  );

  // The highlighted row, clamped so a shrinking result list can't leave it past the end.
  const cursor = hits.length === 0 ? -1 : Math.min(active, hits.length - 1);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function activate(h: Hit) {
    onClose();
    if (h.kind === "recent") onReuse(h.recent);
    else onSelect(h.session.id);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      if (hits.length) setActive((i) => (Math.min(i, hits.length - 1) + 1) % hits.length);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      if (hits.length) setActive((i) => (Math.min(i, hits.length - 1) + hits.length - 1) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor >= 0) activate(hits[cursor]);
    }
  }

  const rowClass = (idx: number) =>
    cn(
      "flex w-full cursor-pointer flex-col gap-1 rounded-md px-2.5 py-2 text-left text-sm",
      idx === cursor && "bg-accent"
    );

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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions and recents…"
            className="border-0 pl-8 shadow-none focus-visible:ring-0"
            spellCheck={false}
          />
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-auto px-1 pb-2">
          {hits.length === 0 && (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              {sessions.length === 0 && recents.length === 0
                ? "Nothing to search yet"
                : `No sessions or recents match “${query.trim()}”`}
            </p>
          )}

          {sessionHits.length > 0 && (
            <>
              <SectionLabel count={sessionHits.length}>Sessions</SectionLabel>
              {sessionHits.map((s, i) => {
                const color = sessionColor(s.color);
                const restorable = s.state === "Restorable";
                return (
                  <div
                    key={s.id}
                    data-idx={i}
                    role="button"
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => activate({ kind: "session", session: s })}
                    className={rowClass(i)}
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
                      <span
                        className={cn(
                          "truncate font-medium",
                          s.state !== "Running" && "text-muted-foreground"
                        )}
                      >
                        <Highlight text={s.name} tokens={tokens} />
                      </span>
                      {s.remoteControl && (
                        <Radio className="size-3 shrink-0 text-muted-foreground" aria-label="remote control" />
                      )}
                      {s.id === activeId && (
                        <Badge variant="secondary" className="shrink-0">
                          current
                        </Badge>
                      )}
                      {/* What the row is, not what activating it does — that is "open", the same as
                          every other row here. The word matches the badge the session header shows
                          and the sidebar's own tooltip, so one state has one name. */}
                      {restorable && (
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                          closed
                        </span>
                      )}
                    </div>
                    <span className="truncate pl-3.5 font-mono text-[10px] text-muted-foreground">
                      <Highlight text={s.workingDirectory} tokens={tokens} />
                    </span>
                  </div>
                );
              })}
            </>
          )}

          {recentHits.length > 0 && (
            <>
              <SectionLabel count={recentHits.length}>Recent</SectionLabel>
              {recentHits.map((r, i) => {
                const idx = sessionHits.length + i;
                return (
                  <div
                    key={idx}
                    data-idx={idx}
                    role="button"
                    tabIndex={-1}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => activate({ kind: "recent", recent: r })}
                    className={rowClass(idx)}
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
              })}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span>
            {hits.length} result{hits.length === 1 ? "" : "s"}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
