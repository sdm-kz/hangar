import { useEffect, useRef, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Info, Radio, Zap } from "lucide-react";

/**
 * The settings a launch carries besides its folder and its prompt — the model, the permission mode
 * and Remote Control.
 *
 * They live here rather than in the New Session dialog because three places now set the same three
 * things: that dialog, the Templates tab beside it, and the template editor, which stores them as a
 * template's defaults. One list of models and one wording of what "bypass all" means beats three
 * that drift.
 */

export const MODELS = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

// How much the session runs unattended. Auto is the default: it auto-approves routine work but
// still stops for genuinely destructive actions. Each hint is drawn under its mode in the dropdown.
export const PERMISSION_MODES = [
  {
    value: "auto",
    label: "Auto",
    hint: "Auto-approves routine actions (edits, most commands) but still asks before genuinely destructive ones like force-push or production deploys.",
  },
  {
    value: "default",
    label: "Ask each time",
    hint: "Claude asks permission for each action — approve them interactively from the Claude Code app.",
  },
  {
    value: "acceptEdits",
    label: "Accept edits",
    hint: "Auto-accepts file edits without asking, but still prompts for bash commands and other actions.",
  },
  {
    value: "bypassPermissions",
    label: "Bypass all (dangerous)",
    hint: "Runs fully unattended — bypasses ALL permission prompts (edits, bash, everything). Claude can run any command without asking.",
  },
];

/** Everything a launch sets beyond its folder, name and prompt. Also what a template remembers. */
export interface LaunchOptions {
  model: string;
  remoteControl: boolean;
  permissionMode: string;
}

/** What a plain "New session" starts from, and what a new template is created with. */
export const DEFAULT_LAUNCH: LaunchOptions = {
  model: "",
  remoteControl: true,
  permissionMode: "auto",
};

/** The same three settings read off a stored template. */
export function launchFromTemplate(t: {
  model: string;
  remoteControl: boolean;
  permissionMode: string;
}): LaunchOptions {
  return {
    model: t.model ?? "",
    remoteControl: t.remoteControl,
    permissionMode: t.permissionMode || "auto",
  };
}

/** The shared select styling — a bare <select>, since the app has no styled one of its own. */
export const selectClass =
  "flex h-9 w-full rounded-md field-edge bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * A checkbox with an icon and a title, and an (i) beside it whose click shows what it does. The
 * paragraph used to sit under every checkbox, which made two of them take as much of the dialog as the
 * folder picker; it is read once, and after that the title says enough.
 */
export function ToggleCard({
  checked,
  onCheckedChange,
  icon,
  title,
  children,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  const [info, setInfo] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  // Closed by a click anywhere else, or Escape. Escape is caught on the window in the capture phase,
  // ahead of the dialog this sits in, which would otherwise close itself instead (as in GroupDialog).
  useEffect(() => {
    if (!info) return;
    const onDown = (e: MouseEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) setInfo(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setInfo(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [info]);

  return (
    <div ref={rowRef} className="relative flex items-center gap-1">
      {/* The (i) is outside the label, so asking what a checkbox does never ticks it. */}
      <label className="flex cursor-pointer items-center gap-3 py-1">
        <Checkbox checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} />
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {icon} {title}
        </span>
      </label>
      <button
        type="button"
        onClick={() => setInfo((v) => !v)}
        aria-expanded={info}
        aria-label={`What “${title}” does`}
        title="What this does"
        className={cn(
          "rounded-md p-1 hover:text-foreground",
          info ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <Info className="size-3.5" />
      </button>
      {info && (
        <div
          role="tooltip"
          className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md popover-edge bg-popover p-2.5 text-xs text-popover-foreground shadow-md"
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The launch settings as a block of fields.
 *
 * `name`/`onName` are optional: a session's name is set where a session is being started, and left
 * out where the block is editing a template's defaults (a template names itself). The name gets the
 * full width, since it is the one field here that is typed into at length (a ticket key and its title).
 * `children` is slotted between the name and the model, which is where the New Session dialog puts its
 * start command; `afterModel` goes between the model and the toggles (its "continue" checkbox).
 */
export function LaunchFields({
  value,
  onChange,
  name,
  onName,
  namePlaceholder,
  idPrefix = "launch",
  children,
  afterModel,
}: {
  value: LaunchOptions;
  onChange: (patch: Partial<LaunchOptions>) => void;
  name?: string;
  onName?: (name: string) => void;
  namePlaceholder?: string;
  /** Distinguishes the labels' `for` targets when two of these are mounted at once (tabs). */
  idPrefix?: string;
  children?: ReactNode;
  afterModel?: ReactNode;
}) {
  const named = onName !== undefined;
  return (
    <>
      {named && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-name`}>Name (optional)</Label>
          <Input
            id={`${idPrefix}-name`}
            value={name ?? ""}
            placeholder={namePlaceholder ?? "Folder name"}
            onChange={(e) => onName?.(e.target.value)}
          />
        </div>
      )}

      {children}

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-model`}>Model</Label>
        <select
          id={`${idPrefix}-model`}
          value={value.model}
          onChange={(e) => onChange({ model: e.target.value })}
          className={selectClass}
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value} className="bg-popover text-popover-foreground">
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {afterModel}

      <ToggleCard
        checked={value.remoteControl}
        onCheckedChange={(v) => onChange({ remoteControl: v })}
        icon={<Radio className="size-3.5" />}
        title="Remote control"
      >
        Start Claude with <code className="font-mono">--remote-control</code> so this session appears in
        the Claude Code app (claude.ai/code &amp; mobile) and you control it from there.
      </ToggleCard>

      <div className="space-y-2">
        <Label id={`${idPrefix}-permission-label`} className="flex items-center gap-1.5">
          <Zap className="size-3.5" /> Permission mode
        </Label>
        <PermissionModePicker
          value={value.permissionMode}
          onChange={(permissionMode) => onChange({ permissionMode })}
          labelledBy={`${idPrefix}-permission-label`}
          id={`${idPrefix}-permission`}
        />
      </div>
    </>
  );
}

/**
 * The permission mode as a dropdown whose rows say what each mode does, in smaller text under its name.
 * Not a native <select>, whose options are one line of plain text: what "Auto" lets through is the thing
 * worth reading before picking it, and under the control it took three lines whatever was picked.
 *
 * Keyboard as NodePicker's: ↓/↑ (or Enter, Space) on the closed control opens it, ↓/↑ move the
 * highlight, Enter or Space picks, Esc closes the list and only the list. It opens upwards when the box it
 * scrolls in has no room for it below — it is the last field in the New session dialog.
 */
function PermissionModePicker({
  value,
  onChange,
  labelledBy,
  id,
}: {
  value: string;
  onChange: (mode: string) => void;
  labelledBy: string;
  id: string;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const current = PERMISSION_MODES.find((m) => m.value === value);

  const show = () => {
    const btn = buttonRef.current?.getBoundingClientRect();
    // The nearest box that scrolls, whose edge would cut the list off; else the window.
    let scroller = boxRef.current?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const area = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    if (btn) setUp(area.bottom - btn.bottom < 280 && btn.top - area.top > area.bottom - btn.bottom);
    const i = PERMISSION_MODES.findIndex((m) => m.value === value);
    setActive(i < 0 ? 0 : i); // starts on the current one, so Enter straight away keeps it
    setOpen(true);
  };

  // Close on a click outside. Esc is caught on the window, ahead of the dialog's own listener on the
  // document, so it folds the list away rather than closing the dialog the list sits in.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc, true);
    };
  }, [open]);

  const pick = (mode: string) => {
    setOpen(false);
    buttonRef.current?.focus();
    if (mode !== value) onChange(mode);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show();
      const n = PERMISSION_MODES.length;
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter" || e.key === " ") {
      // Enter would otherwise submit the form the picker sits in. (Ctrl+Enter is left to the form.)
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      if (open) pick(PERMISSION_MODES[active].value);
      else show();
    } else if (e.key === "Tab" && open) {
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-controls={`${id}-list`}
        aria-expanded={open}
        aria-labelledby={labelledBy}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        title={current?.hint}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={cn(selectClass, "items-center justify-between gap-2 text-left hover:bg-accent/50")}
      >
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDown className="size-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-labelledby={labelledBy}
          className={cn(
            "absolute left-0 right-0 z-50 max-h-96 overflow-y-auto overscroll-contain rounded-md popover-edge bg-popover p-1 text-popover-foreground shadow-md",
            up ? "bottom-full mb-1" : "top-full mt-1"
          )}
        >
          {PERMISSION_MODES.map((m, i) => (
            <div
              key={m.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={m.value === value}
              onMouseEnter={() => setActive(i)}
              // mousedown, not click: the outside-click listener runs on mousedown too, and focus stays on
              // the control rather than moving to a row that is about to go.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m.value);
              }}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5",
                i === active && "bg-accent"
              )}
            >
              <Check className={cn("mt-0.5 size-3.5 shrink-0", m.value === value ? "opacity-100" : "opacity-0")} />
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm">{m.label}</div>
                <div className="text-xs leading-snug text-muted-foreground">{m.hint}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
