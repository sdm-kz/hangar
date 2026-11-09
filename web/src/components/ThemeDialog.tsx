import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import {
  getTheme,
  getThemeChoice,
  getThemeLibrary,
  getThemeMode,
  getThemeVersion,
  listThemes,
  previewCustomColors,
  setThemeChoice,
  setThemeLibrary,
  setThemeMode,
  subscribeThemeChanges,
  themeBaseColors,
  type Theme,
  type ThemeEntry,
  type ThemeMode,
} from "@/lib/theme";
import { THEME_TOKENS, inheritedValue, isColor, toHex, type ThemeColors, type TokenGroup } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, Monitor, Moon, Palette, RotateCcw, Sun, Trash2 } from "lucide-react";

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

const MODES: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
  { mode: "system", label: "System", icon: Monitor },
];

const GROUPS: { group: TokenGroup; label: string }[] = [
  { group: "interface", label: "Interface" },
  { group: "syntax", label: "Code" },
  { group: "terminal", label: "Terminal" },
];

/** Re-render on any theme change: a pick, the mode, a colour, the list of themes. */
function useThemeVersion() {
  return useSyncExternalStore(subscribeThemeChanges, getThemeVersion);
}

/**
 * The sidebar's Themes dialog: light, dark or the system's choice; which theme each of the two shows;
 * and the colours of a theme of your own, made from any other and kept on the server.
 */
export function ThemeDialog({ onClose }: { onClose: () => void }) {
  useThemeVersion();
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mode = getThemeMode();
  const themes = listThemes();
  const showing = getTheme();
  const active = themes.find((t) => t.id === getThemeChoice(showing));
  const editable = editing ? themes.find((t) => t.id === editing && t.source === "custom") : undefined;

  // A built-in or a settings-file theme can't be changed here, so customising one makes a copy of it
  // (with no colours of its own yet) and shows that in its place.
  const customize = async (theme: ThemeEntry) => {
    if (theme.source === "custom") {
      setEditing(theme.id);
      return;
    }
    setBusy(true);
    try {
      const before = new Set(getThemeLibrary().custom.map((t) => t.id));
      const state = await api.createTheme({ name: `${theme.name} (custom)`, base: theme.id });
      const made = state.custom.find((t) => !before.has(t.id));
      setThemeLibrary(state);
      if (made) {
        setThemeChoice(theme.kind, made.id);
        setEditing(made.id);
      }
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(var(--app-height,100dvh)-2rem)] max-w-2xl overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Themes</DialogTitle>
          <DialogDescription>
            {editable
              ? "Changes show as you make them, and are kept for every browser signed in here."
              : "Pick a theme for light mode and one for dark. Your picks stay in this browser."}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {editable ? (
          <ThemeEditor key={editable.id} theme={editable} onBack={() => setEditing(null)} onError={setError} />
        ) : (
          <>
            <div className="flex gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Mode">
              {MODES.map(({ mode: m, label, icon: Icon }) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
                    mode === m ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => setThemeMode(m)}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              ))}
            </div>
            {(["light", "dark"] as Theme[]).map((kind) => (
              <ThemeGrid
                key={kind}
                kind={kind}
                themes={themes.filter((t) => t.kind === kind)}
                chosen={getThemeChoice(kind)}
                showing={showing === kind}
              />
            ))}
            {active && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
                <p className="text-sm text-muted-foreground">
                  Showing <span className="font-medium text-foreground">{active.name}</span>
                </p>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => customize(active)}>
                  <Palette />
                  {active.source === "custom" ? "Edit colors" : "Customize colors"}
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ThemeGrid({ kind, themes, chosen, showing }: { kind: Theme; themes: ThemeEntry[]; chosen: string; showing: boolean }) {
  return (
    <section className="grid gap-2">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {kind === "light" ? "Light theme" : "Dark theme"}
        {showing && <span className="text-xs font-normal text-muted-foreground">showing now</span>}
      </h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {themes.map((t) => (
          <ThemeSwatch key={t.id} theme={t} selected={t.id === chosen} onClick={() => setThemeChoice(kind, t.id)} />
        ))}
      </div>
    </section>
  );
}

/** A theme drawn small, in its own colours: a page, a card on it, its text, its primary, and its terminal's colours. */
function ThemeSwatch({ theme, selected, onClick }: { theme: ThemeEntry; selected: boolean; onClick: () => void }) {
  const c = theme.colors;
  const badge = theme.source === "custom" ? "custom" : theme.source === "config" ? "settings" : theme.tuned ? "tuned" : null;
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={theme.name}
      className={cn(
        "grid min-w-0 gap-1.5 rounded-lg p-1.5 text-left transition-colors hover:bg-accent",
        selected && "bg-accent ring-2 ring-primary"
      )}
      onClick={onClick}
    >
      <div
        className="grid h-14 grid-rows-[1fr_auto] gap-1 overflow-hidden rounded-md p-1.5"
        style={{ background: c.background, color: c.foreground, boxShadow: `inset 0 0 0 1px ${c.border}` }}
      >
        <div className="flex items-center gap-1.5 rounded px-1.5" style={{ background: c.card }}>
          <span className="text-xs font-semibold">Aa</span>
          <span className="h-1.5 flex-1 rounded-full" style={{ background: c["muted-foreground"], opacity: 0.5 }} />
          <span className="size-2.5 rounded-full" style={{ background: c.primary }} />
        </div>
        <div className="flex gap-0.5">
          {["red", "green", "yellow", "blue", "magenta", "cyan"].map((name) => (
            <span key={name} className="h-1.5 flex-1 rounded-full" style={{ background: c[`terminal-${name}`] }} />
          ))}
        </div>
      </div>
      <span className="flex min-w-0 items-center gap-1 px-0.5 text-xs">
        <span className="truncate">{theme.name}</span>
        {badge && (
          <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px] font-normal">
            {badge}
          </Badge>
        )}
      </span>
    </button>
  );
}

/**
 * A custom theme's colours, every one editable: a picker for the quick change and the CSS value beside it
 * for the exact one (any CSS colour — oklch(), an alpha, color-mix()). A colour changed here shows at once
 * and is saved a moment later; reset hands it back to the theme it was made from.
 */
function ThemeEditor({ theme, onBack, onError }: { theme: ThemeEntry; onBack: () => void; onError: (e: string | null) => void }) {
  const own = getThemeLibrary().custom.find((t) => t.id === theme.id);
  const [name, setName] = useState(own?.name ?? theme.name);
  const [overrides, setOverrides] = useState<ThemeColors>(own?.colors ?? {});
  const base = themeBaseColors(theme.id);
  const baseName = listThemes().find((t) => t.id === own?.base)?.name;
  const confirm = useConfirm();

  // Saving is a moment behind the edit, so a drag across the picker is one request rather than fifty;
  // and only the newest save's answer is taken, so an older one can't put back a colour since changed.
  const pending = useRef<ThemeColors | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const seq = useRef(0);
  const flush = () => {
    window.clearTimeout(timer.current);
    const colors = pending.current;
    if (!colors) return;
    pending.current = null;
    const mine = ++seq.current;
    api.updateTheme(theme.id, { colors }).then(
      (state) => {
        if (seq.current === mine && !pending.current) setThemeLibrary(state);
        onError(null);
      },
      (e) => onError(message(e))
    );
  };
  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps -- save what is left on the way out

  const change = (token: string, value: string | null) => {
    const next = { ...overrides };
    if (value === null) delete next[token];
    else next[token] = value;
    setOverrides(next);
    previewCustomColors(theme.id, next);
    pending.current = next;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 400);
  };

  const rename = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === own?.name) return setName(own?.name ?? theme.name);
    // Colours still waiting to be saved go first: the rename's answer carries the colours the server
    // has, and would otherwise put back the ones just changed.
    flush();
    api.updateTheme(theme.id, { name: trimmed }).then(setThemeLibrary, (e) => onError(message(e)));
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${theme.name}?`,
      description: "Browsers showing it go back to their default theme.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    window.clearTimeout(timer.current);
    pending.current = null;
    try {
      setThemeLibrary(await api.deleteTheme(theme.id));
      onBack();
    } catch (e) {
      onError(message(e));
    }
  };

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="size-8 shrink-0" title="Back to the themes" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <Input
          aria-label="Theme name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" title="Delete this theme" onClick={remove}>
          <Trash2 />
        </Button>
      </div>
      {baseName && <p className="-mt-2 text-xs text-muted-foreground">Made from {baseName}</p>}
      {GROUPS.map(({ group, label }) => (
        <section key={group} className="grid gap-1">
          <h3 className="text-sm font-medium">{label}</h3>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {THEME_TOKENS.filter((t) => t.group === group).map((t) => (
              <ColorRow
                key={t.id}
                label={t.label}
                value={overrides[t.id] ?? inheritedValue(base, overrides, t.id) ?? ""}
                overridden={t.id in overrides}
                onChange={(v) => change(t.id, v)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ColorRow({
  label,
  value,
  overridden,
  onChange,
}: {
  label: string;
  value: string;
  overridden: boolean;
  onChange: (value: string | null) => void;
}) {
  // What is typed, kept apart from the value until it is a colour: "#1e1e2" on the way to "#1e1e2e"
  // must neither be painted nor be thrown away.
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const invalid = draft.trim() !== "" && !isColor(draft.trim());

  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5">
      {/* The swatch is drawn from the value itself, and the picker laid over it unseen: a colour input
          shows only #rrggbb, and would paint a 10%-white border as solid white. */}
      <label className="relative size-7 shrink-0 cursor-pointer rounded field-edge p-0.5">
        <span className="block size-full rounded-sm" style={{ background: value }} />
        <input
          type="color"
          aria-label={label}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          value={toHex(value || "#000000")}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <span className={cn("min-w-0 flex-1 truncate text-sm", overridden ? "font-medium" : "text-muted-foreground")} title={label}>
        {label}
      </span>
      <Input
        aria-label={`${label} value`}
        className={cn("h-7 w-28 shrink-0 px-2 font-mono text-xs", invalid && "border-destructive")}
        value={draft}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = e.target.value.trim();
          if (v && isColor(v) && v !== value) onChange(v);
        }}
        onBlur={() => setDraft(value)}
      />
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-7 shrink-0 text-muted-foreground", !overridden && "invisible")}
        title="Reset to the theme it was made from"
        onClick={() => onChange(null)}
      >
        <RotateCcw />
      </Button>
    </div>
  );
}
