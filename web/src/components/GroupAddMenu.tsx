import { useCallback, useState } from "react";
import { useDismissable } from "@/lib/useDismissable";
import { FolderTree, Globe, Loader2, Plus, TerminalSquare } from "lucide-react";
import { shellIcon, useShellOptions } from "./ShellTabStrip";

/**
 * The "+" at the end of a group's strip: what can be opened in this group. A new shell (in any of
 * the shells this machine has) or a pinned page opens here; the Claude terminal and the Files
 * explorer, which always exist somewhere, are brought over from wherever they are.
 */
export function GroupAddMenu({
  busy,
  hasClaude,
  hasFiles,
  onBring,
  onOpenShell,
  onAddLink,
}: {
  /** A shell is being launched. */
  busy: boolean;
  /** Whether the Claude terminal / the Files explorer are in this group already. */
  hasClaude: boolean;
  hasFiles: boolean;
  onBring: (what: "claude" | "files") => void;
  onOpenShell: (shell: string) => void;
  onAddLink: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable<HTMLDivElement>(open, close);
  const shells = useShellOptions(open);

  const item = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent";
  return (
    <div ref={ref} className="relative flex shrink-0 items-stretch">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Open in this group"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center px-2 text-muted-foreground hover:text-foreground"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-md popover-edge bg-popover p-1 text-popover-foreground shadow-md"
        >
          {!hasClaude && (
            <button role="menuitem" className={item} onClick={() => (onBring("claude"), close())}>
              <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">Terminal</span>
              <span className="text-xs text-muted-foreground">move here</span>
            </button>
          )}
          {!hasFiles && (
            <button role="menuitem" className={item} onClick={() => (onBring("files"), close())}>
              <FolderTree className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">Files</span>
              <span className="text-xs text-muted-foreground">move here</span>
            </button>
          )}
          {(!hasClaude || !hasFiles) && <div className="my-1 h-px bg-border" />}
          <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            New shell
          </div>
          {shells.failed ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              Could not read the shell list — reopen this menu to try again.
            </div>
          ) : shells.options === null ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Looking for shells…
            </div>
          ) : shells.options.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No shells were found.</div>
          ) : (
            shells.options.map((o) => {
              const Icon = shellIcon(o.kind);
              return (
                <button
                  key={o.id}
                  role="menuitem"
                  title={o.detail}
                  className={item}
                  onClick={() => {
                    shells.remember(o.id);
                    onOpenShell(o.id);
                    close();
                  }}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.id === shells.preferred && <span className="text-xs text-muted-foreground">default</span>}
                </button>
              );
            })
          )}
          <div className="my-1 h-px bg-border" />
          <button role="menuitem" className={item} onClick={() => (onAddLink(), close())}>
            <Globe className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">Link a web page…</span>
          </button>
        </div>
      )}
    </div>
  );
}
