import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellInfo, ShellOption } from "@/types";
import { api } from "@/lib/api";
import { useDismissable } from "@/lib/useDismissable";
import { cn } from "@/lib/utils";
import { ChevronDown, Loader2, Plus, SquareTerminal, Terminal, X } from "lucide-react";

// Which shell a new tab opens with, remembered per browser. The server has a sensible default
// (newest PowerShell present), but someone who works in WSL should get WSL on the next click
// rather than picking it out of the menu every time.
const LAST_SHELL_KEY = "claudeweb.lastShell";

function readLastShell(): string | null {
  try {
    return localStorage.getItem(LAST_SHELL_KEY);
  } catch {
    return null;
  }
}

function rememberShell(id: string) {
  try {
    localStorage.setItem(LAST_SHELL_KEY, id);
  } catch {
    /* private window — the server default stands in */
  }
}

/**
 * The icon for a shell family. Deliberately a small set: several WSL distributions share one, and a
 * shell nobody anticipated (a future entry in the catalog) still gets the generic terminal.
 */
export function shellIcon(kind: string) {
  return kind === "cmd" ? SquareTerminal : Terminal;
}

/**
 * The shells this machine can open, fetched the first time `wanted` turns true and kept after that,
 * plus the one a bare "+" should open. Shared by the strip's own menu and the split pane's "+" menu.
 */
export function useShellOptions(wanted: boolean) {
  const [options, setOptions] = useState<ShellOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [serverDefault, setServerDefault] = useState<string | null>(null);
  const fetchingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!wanted || options || fetchingRef.current) return;
    fetchingRef.current = true;
    setFailed(false);
    void api
      .shellOptions()
      .then((r) => {
        if (cancelled) return;
        setOptions(r.shells);
        setServerDefault(r.default);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => {
        fetchingRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, options]);

  const last = readLastShell();
  const preferred =
    last && (!options || options.some((o) => o.id === last)) ? last : serverDefault ?? undefined;
  return { options, failed, preferred, remember: rememberShell };
}

/** Short label for a tab — the full one goes in the tooltip, where there's room for the path. */
export function shellTabLabel(shell: ShellInfo): string {
  // "Ubuntu-24.04 (WSL)" is the menu's phrasing, where the family needs saying; on a tab the
  // distribution name alone is both shorter and more distinguishing.
  return shell.kind === "wsl" ? shell.label.replace(/\s*\(WSL\)$/, "") : shell.label;
}

/**
 * The session's open shell tabs, sitting in its tab bar after the file tabs, plus the "+" that opens
 * another one. A shell is a view of the session like the terminal and the files are, so it gets a
 * tab of the same standing.
 *
 * The tabs themselves live on the **server** (see ShellManager), not in this browser: open one on a
 * laptop and it is there on the phone, and it keeps running — with whatever is building in it —
 * across a restart of the app.
 */
export function ShellTabStrip({
  shells,
  activeId,
  showingShell,
  busy,
  onActivate,
  onOpen,
  onClose,
  className,
}: {
  shells: ShellInfo[];
  activeId: string | null;
  // Whether a shell is the surface currently showing (as opposed to being open but behind Files).
  showingShell: boolean;
  // A shell is being launched — the "+" spins rather than accepting a second click.
  busy: boolean;
  onActivate: (id: string) => void;
  onOpen: (shell: string) => void;
  onClose: (id: string) => void;
  // Overrides the default right-alignment — the folder view has nothing else in the row.
  className?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [options, setOptions] = useState<ShellOption[] | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [serverDefault, setServerDefault] = useState<string | null>(null);
  // In flight, so a failure doesn't re-enter the effect on its own state change and spin.
  const fetchingRef = useRef(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const menuRef = useDismissable<HTMLDivElement>(menuOpen, closeMenu);
  const scrollRef = useRef<HTMLDivElement>(null);

  // What this machine can run is a fact about the server, so it's fetched once and kept — a shell
  // is not installed mid-session often enough to justify asking on every menu open. A failure is
  // left as a failure rather than cached as "no shells": that answer would outlive the outage that
  // produced it and the menu would read empty for the rest of the page's life.
  useEffect(() => {
    let cancelled = false;
    if (!menuOpen || options || fetchingRef.current) return;
    fetchingRef.current = true;
    setOptionsFailed(false);
    void api
      .shellOptions()
      .then((r) => {
        if (cancelled) return;
        setOptions(r.shells);
        setServerDefault(r.default);
      })
      .catch(() => !cancelled && setOptionsFailed(true))
      .finally(() => {
        fetchingRef.current = false;
      });
    return () => {
      cancelled = true;
    };
    // Re-runs on the next open, which is the retry: `options` is still null after a failure.
  }, [menuOpen, options]);

  // Same horizontal-wheel handling the file tabs have, so a crowded bar scrolls the way it looks
  // like it should. Native and non-passive, since React's onWheel can't preventDefault.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // The shell a bare "+" click opens: this browser's last pick if it's still installed, else the
  // server's default.
  const preferred = (() => {
    const last = readLastShell();
    if (last && (!options || options.some((o) => o.id === last))) return last;
    return serverDefault ?? undefined;
  })();

  const open = (shell?: string) => {
    if (shell) rememberShell(shell);
    onOpen(shell ?? preferred ?? "");
    setMenuOpen(false);
  };

  return (
    // ml-auto so the strip ends the row whether or not there are file tabs beside it (those take
    // the slack when they exist): the "+" is then always in the same place.
    <div className={cn("ml-auto flex h-full min-w-0 items-stretch", className)}>
      {!className && <div className="my-2 w-px shrink-0 bg-border" />}
      <div ref={scrollRef} className="hover-scrollbar flex min-w-0 items-stretch overflow-x-auto">
        {shells.map((s) => {
          const Icon = shellIcon(s.kind);
          const current = s.id === activeId;
          const active = current && showingShell;
          return (
            <div
              key={s.id}
              role="tab"
              aria-selected={active}
              data-current={current}
              title={`${s.label} — ${s.workingDirectory}${s.running ? "" : " (exited)"}`}
              onClick={() => onActivate(s.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(s.id);
                }
              }}
              className={cn(
                "group/shell flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-b-2 pl-3 pr-2 text-sm font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : current
                    ? "border-border text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="size-4 shrink-0" />
              {/* A shell whose process has ended keeps its tab (the output is still worth reading)
                  but says so, rather than looking like a live prompt that ignores typing. */}
              <span className={cn("max-w-[10rem] truncate", !s.running && "line-through opacity-60")}>
                {shellTabLabel(s)}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(s.id);
                }}
                title="Close shell"
                className={cn(
                  "rounded p-0.5 hover:bg-accent hover:text-foreground",
                  current ? "opacity-100" : "opacity-0 group-hover/shell:opacity-100"
                )}
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {/* "+" opens the preferred shell straight away; the chevron beside it picks a different one. */}
      <div ref={menuRef} className="relative flex shrink-0 items-stretch">
        <button
          type="button"
          onClick={() => open()}
          disabled={busy}
          title="Open a shell in this session's folder"
          className="flex items-center pl-2 pr-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          title="Choose a shell"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex items-center pr-2 text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="size-3.5" />
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-md popover-edge bg-popover p-1 shadow-md"
          >
            {optionsFailed ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                Could not read the shell list — reopen this menu to try again.
              </div>
            ) : options === null ? (
              <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Looking for shells…
              </div>
            ) : options.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No shells were found.</div>
            ) : (
              options.map((o) => {
                const Icon = shellIcon(o.kind);
                return (
                  <button
                    key={o.id}
                    role="menuitem"
                    onClick={() => open(o.id)}
                    title={o.detail}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.id === preferred && <span className="text-xs text-muted-foreground">default</span>}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
