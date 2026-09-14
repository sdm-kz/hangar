import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Activity, Radio, Zap } from "lucide-react";

/**
 * The settings a launch carries besides its folder and its prompt — the model, the permission mode,
 * Remote Control and the hang watchdog.
 *
 * They live here rather than in the New Session dialog because three places now set the same four
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
// still stops for genuinely destructive actions. Descriptions surface under the dropdown.
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
  watchdog: boolean;
}

/** What a plain "New session" starts from, and what a new template is created with. */
export const DEFAULT_LAUNCH: LaunchOptions = {
  model: "",
  remoteControl: true,
  permissionMode: "auto",
  watchdog: false, // the hang watchdog is opt-in, here as everywhere
};

/** The same four settings read off a stored template. */
export function launchFromTemplate(t: {
  model: string;
  remoteControl: boolean;
  permissionMode: string;
  watchdogEnabled: boolean;
}): LaunchOptions {
  return {
    model: t.model ?? "",
    remoteControl: t.remoteControl,
    permissionMode: t.permissionMode || "auto",
    watchdog: t.watchdogEnabled,
  };
}

/** The shared select styling — a bare <select>, since the app has no styled one of its own. */
const selectClass =
  "flex h-9 w-full rounded-md field-edge bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** A checkbox with a title, an icon and a paragraph saying what it does — the whole card clicks. */
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
  return (
    <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className="mt-0.5"
      />
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {icon} {title}
        </div>
        <p className="text-xs text-muted-foreground">{children}</p>
      </div>
    </label>
  );
}

/**
 * The launch settings as a block of fields.
 *
 * `name`/`onName` are optional: a session's name is set where a session is being started, and left
 * out where the block is editing a template's defaults (a template names itself). `children` is
 * slotted between the name/model row and the toggles, which is where the New Session dialog puts its
 * start command and its "continue" checkbox.
 */
export function LaunchFields({
  value,
  onChange,
  name,
  onName,
  namePlaceholder,
  idPrefix = "launch",
  children,
}: {
  value: LaunchOptions;
  onChange: (patch: Partial<LaunchOptions>) => void;
  name?: string;
  onName?: (name: string) => void;
  namePlaceholder?: string;
  /** Distinguishes the labels' `for` targets when two of these are mounted at once (tabs). */
  idPrefix?: string;
  children?: ReactNode;
}) {
  const named = onName !== undefined;
  return (
    <>
      <div className={named ? "grid grid-cols-2 gap-3" : "space-y-2"}>
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
      </div>

      {children}

      <ToggleCard
        checked={value.remoteControl}
        onCheckedChange={(v) => onChange({ remoteControl: v })}
        icon={<Radio className="size-3.5" />}
        title="Remote control"
      >
        Start Claude with <code className="font-mono">--remote-control</code> so this session appears in
        the Claude Code app (claude.ai/code &amp; mobile) and you control it from there.
      </ToggleCard>

      <ToggleCard
        checked={value.watchdog}
        onCheckedChange={(v) => onChange({ watchdog: v })}
        icon={<Activity className="size-3.5" />}
        title="Hang watchdog"
      >
        Auto-sends <code className="font-mono">continue</code> when the session hangs on an API or
        streaming error. Off by default; you can also toggle it later from the session header.
      </ToggleCard>

      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Zap className="size-3.5" /> Permission mode
        </div>
        <select
          value={value.permissionMode}
          onChange={(e) => onChange({ permissionMode: e.target.value })}
          className={selectClass}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m.value} value={m.value} className="bg-popover text-popover-foreground">
              {m.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {PERMISSION_MODES.find((m) => m.value === value.permissionMode)?.hint}
        </p>
      </div>
    </>
  );
}
