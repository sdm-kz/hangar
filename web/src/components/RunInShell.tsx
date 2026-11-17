import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent } from "react";
import { AlertTriangle, ChevronDown, Loader2, Play, Plus } from "lucide-react";
import { useDismissable } from "@/lib/useDismissable";
import { cn } from "@/lib/utils";
import { shellIcon, useShellOptions } from "./ShellTabStrip";

/**
 * Running a chat code block in one of the session's shells: the Run button beside a block's Copy, and
 * the context through which the session view hands it the shells and the means to type into them.
 *
 * Nothing outside a session provides the context, so Markdown anywhere else draws no Run button.
 */

/** One of the session's shells, as the Run menu lists it. */
export interface RunShell {
  id: string;
  label: string;
  /** Its family ("powershell", "cmd", "bash", "wsl", "ssh"), for the icon. */
  kind: string;
  /** A command is running in it: what is typed now goes to that command, not to the prompt. */
  busy: boolean;
}

/** What a run did: where the text went, and whether that shell is on screen to watch it. */
export type RunResult = { ok: true; shell: RunShell; shown: boolean } | { ok: false; message: string };

export interface ShellRunApi {
  shells: RunShell[];
  /** The shell a plain click runs in: the one last run in, else the one last picked. */
  defaultId: string | null;
  /** Paste the text into a shell, and with `enter` run it. */
  run: (id: string, text: string, enter: boolean) => Promise<RunResult>;
  /** Open a new shell (a ShellOption id), wait for its prompt, then paste into it. */
  openAndRun: (option: string, text: string, enter: boolean) => Promise<RunResult>;
  /** Bring a shell's tab forward. */
  show: (id: string) => void;
}

export const ShellRunContext = createContext<ShellRunApi | null>(null);

// The fence languages that are commands. A block with no language is offered too: that is how most
// commands come, as in "run this:" followed by a bare block.
const SHELL_LANGUAGES = new Set([
  "sh", "bash", "zsh", "fish", "ksh", "shell", "shellsession", "console", "terminal",
  "powershell", "pwsh", "ps", "ps1", "posh", "cmd", "bat", "batch", "dos",
]);

/** Whether a block fenced in this language (null: none) is a command worth offering to run. */
export function isShellLanguage(language: string | null): boolean {
  return language === null || SHELL_LANGUAGES.has(language.toLowerCase());
}

// Why a block of several lines has no Paste only.
const SEVERAL_LINES = "Several lines can only be run: a shell runs each one as it lands";

// How long "Ran in PowerShell · Show" stays by the block.
const NOTICE_MS = 6000;

const BUTTON =
  "flex h-6 select-none items-center rounded-md border text-xs transition-opacity focus-visible:opacity-100 group-hover/code:opacity-100 [@media(pointer:coarse)]:opacity-100";

/**
 * The Run button on a code block. With shells to run in: a solid split button, its main half running
 * in the default shell and its arrow opening the list. With none: a muted outline that offers to open
 * one. Shift+click pastes without pressing Enter — a block of one line: several can only be run, each
 * as it lands (see TerminalPaneHandle.paste).
 *
 * `text` is read on the click, like Copy's.
 */
export function RunInShellButton({ text }: { text: () => string }) {
  const api = useContext(ShellRunContext);
  const [menu, setMenu] = useState(false);
  const [pasteOnly, setPasteOnly] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ result: RunResult; enter: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = useCallback(() => setMenu(false), []);
  const ref = useDismissable<HTMLDivElement>(menu, close);
  const options = useShellOptions(menu && !!api);

  const report = useCallback((result: RunResult, enter: boolean) => {
    window.clearTimeout(timer.current);
    // Nothing to say when it worked where you can see it: the shell shows it.
    if (result.ok && result.shown) return setNotice(null);
    setNotice({ result, enter });
    timer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const go = useCallback(
    async (start: () => Promise<RunResult>, enter: boolean) => {
      setMenu(false);
      setWorking(true);
      try {
        report(await start(), enter);
      } finally {
        setWorking(false);
      }
    },
    [report]
  );

  if (!api) return null;
  const shells = api.shells;
  const target = shells.find((s) => s.id === api.defaultId) ?? shells[0];
  const multiline = text().includes("\n");

  const onMain = (e: MouseEvent) => {
    e.stopPropagation();
    // No shell to run in, or the one it would go to is busy: the menu, which says so, rather than a guess.
    if (!target || target.busy) return setMenu((m) => !m);
    const enter = !e.shiftKey;
    if (!enter && multiline) return report({ ok: false, message: SEVERAL_LINES }, false);
    void go(() => api.run(target.id, text(), enter), enter);
  };

  const item = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-50";
  const heading = "px-2 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground";
  const label = target
    ? `Run in ${target.label}${target.busy ? " — a command is running there" : ""}${multiline ? "" : " (Shift+click to paste without running)"}`
    : "Run in a shell — there is none open yet";
  // Paste only is for one line; ticked for a block of one, then left on a block of several, it does nothing.
  const paste = pasteOnly && !multiline;

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      {notice && <Notice notice={notice} onShow={(id) => (api.show(id), setNotice(null))} />}
      {target ? (
        <div className={cn(BUTTON, "overflow-hidden border-primary bg-primary text-primary-foreground", menu || notice ? "opacity-100" : "opacity-0")}>
          <button type="button" onClick={onMain} title={label} aria-label={label} className="flex h-full items-center gap-1 pl-1.5 pr-1.5 hover:bg-primary-foreground/15">
            {working ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3 fill-current" />}
            <span>Run</span>
            {target.busy && <AlertTriangle className="size-3" />}
          </button>
          <button
            type="button"
            onClick={(e) => (e.stopPropagation(), setMenu((m) => !m))}
            title="Choose where to run"
            aria-label="Choose where to run"
            aria-haspopup="menu"
            aria-expanded={menu}
            className="flex h-full items-center border-l border-primary-foreground/30 px-0.5 hover:bg-primary-foreground/15"
          >
            <ChevronDown className="size-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onMain}
          title={label}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={menu}
          className={cn(BUTTON, "gap-1 border-dashed bg-background/80 px-1.5 text-muted-foreground hover:text-foreground", menu || notice ? "opacity-100" : "opacity-0")}
        >
          {working ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          <span>Run</span>
        </button>
      )}
      {menu && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-md popover-edge bg-popover p-1 text-popover-foreground shadow-md"
        >
          {shells.length > 0 && (
            <>
              <div className={heading}>{paste ? "Paste in" : "Run in"}</div>
              {shells.map((s) => {
                const Icon = shellIcon(s.kind);
                return (
                  <button
                    key={s.id}
                    role="menuitem"
                    title={s.busy ? "A command is running here: the text goes to it, not to the prompt" : undefined}
                    className={item}
                    onClick={(e) => {
                      const enter = !paste && !(e.shiftKey && !multiline);
                      void go(() => api.run(s.id, text(), enter), enter);
                    }}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    {s.busy ? (
                      <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="size-3.5" /> busy
                      </span>
                    ) : (
                      shells.length > 1 &&
                      s.id === target?.id && <span className="text-xs text-muted-foreground">default</span>
                    )}
                  </button>
                );
              })}
              <div className="my-1 h-px bg-border" />
            </>
          )}
          <div className={heading}>{shells.length ? "Open a new shell" : "No shell is open — open one"}</div>
          {options.failed ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">Could not read the shell list — reopen this menu to try again.</div>
          ) : options.options === null ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Looking for shells…
            </div>
          ) : options.options.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No shells were found.</div>
          ) : (
            options.options.map((o) => {
              const Icon = shellIcon(o.kind);
              return (
                <button
                  key={o.id}
                  role="menuitem"
                  title={o.detail}
                  className={item}
                  onClick={() => {
                    options.remember(o.id);
                    void go(() => api.openAndRun(o.id, text(), !paste), !paste);
                  }}
                >
                  <Plus className="size-3 shrink-0 text-muted-foreground" />
                  <Icon className="-ml-1 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {o.label}
                    <span className="text-muted-foreground"> {paste ? "and paste" : "and run"}</span>
                  </span>
                  {o.id === options.preferred && <span className="text-xs text-muted-foreground">default</span>}
                </button>
              );
            })
          )}
          <div className="my-1 h-px bg-border" />
          {multiline ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{SEVERAL_LINES}.</div>
          ) : (
            <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
              <input type="checkbox" checked={pasteOnly} onChange={(e) => setPasteOnly(e.target.checked)} className="accent-primary" />
              <span className="flex-1">Paste only — don't press Enter</span>
              <span className="text-xs text-muted-foreground">Shift</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

/** "Ran in PowerShell · Show", beside the button, when the shell it went to is not on screen; or why it failed. */
function Notice({ notice, onShow }: { notice: { result: RunResult; enter: boolean }; onShow: (id: string) => void }) {
  const { result, enter } = notice;
  return (
    <span
      role="status"
      className={cn(
        "flex h-6 items-center gap-1 whitespace-nowrap rounded-md border bg-background px-2 text-xs shadow-sm",
        !result.ok && "border-destructive/50 text-destructive"
      )}
    >
      {result.ok ? (
        <>
          <span className="text-muted-foreground">
            {enter ? "Ran in" : "Pasted in"} {result.shell.label} ·
          </span>
          <button type="button" onClick={(e) => (e.stopPropagation(), onShow(result.shell.id))} className="font-medium text-primary hover:underline">
            Show
          </button>
        </>
      ) : (
        result.message
      )}
    </span>
  );
}
