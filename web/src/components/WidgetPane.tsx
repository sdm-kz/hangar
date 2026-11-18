import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileCode, KeyRound, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import type { WidgetInstance, WidgetTypeInfo } from "@/types";
import type { WidgetFeedState } from "@/lib/sessionWidgets";
import { widgetIcon } from "@/lib/widgetIcons";
import { useApi } from "@/lib/node";
import { age } from "@/lib/age";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WidgetFrame } from "./WidgetFrame";
import { ZoomControls, usePersistentReadingWidth, usePersistentZoom } from "./ZoomControls";

/** What a widget needs to be drawn anywhere: the instance, its type, its feed, and what it can do. */
export interface WidgetBodyProps {
  sessionId: string;
  instance: WidgetInstance;
  type: WidgetTypeInfo | undefined;
  feed: WidgetFeedState;
  /** True while the session sits in a project: secrets may then be saved for that project alone. */
  inProject: boolean;
  onRefresh: () => Promise<WidgetFeedState | undefined | void>;
  onToChat: (text: string) => void;
  /** Secrets were saved: the types are re-read (their missing list) and the feed run again. */
  onSecretsSaved: () => void;
  /** Open the widget's files (its folder in the Files tab, widget.json in the viewer); absent where it can't be. */
  onSource?: () => void;
}

/** The Source button: a widget's files, where any file of the machine is opened. */
function SourceButton({ onSource, label }: { onSource: () => void; label?: boolean }) {
  return (
    <button
      type="button"
      onClick={onSource}
      title="Open this widget's files: its folder in the Files tab, widget.json in the viewer"
      className="flex shrink-0 items-center gap-1 rounded p-1 hover:bg-accent hover:text-foreground"
    >
      <FileCode className="size-3.5" />
      {label && <span>Source</span>}
    </button>
  );
}

/** "Fetched 4m ago", "fetching…", or the error, for the line above the view. */
function Status({
  feed,
  type,
  onRefresh,
  onSource,
}: {
  feed: WidgetFeedState;
  type?: WidgetTypeInfo;
  onRefresh: () => void;
  onSource?: () => void;
}) {
  const a = feed.answer;
  const error = a?.error ?? feed.failure;
  // Re-drawn every half minute, so "1m ago" moves on while nothing else does.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const when = !a?.fetchedAt ? "" : Date.now() - new Date(a.fetchedAt).getTime() < 60_000 ? "just now" : `${age(a.fetchedAt)} ago`;
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2 text-xs text-muted-foreground">
      {error ? (
        <span className="flex min-w-0 items-center gap-1 text-destructive" title={error}>
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="truncate">{error}</span>
        </span>
      ) : (
        <span className="truncate">
          {feed.loading ? "Fetching…" : when ? `Fetched ${when}` : ""}
          {type?.source === "claude" && !feed.loading && " · via Claude"}
        </span>
      )}
      <span className="ml-auto" />
      {onSource && <SourceButton onSource={onSource} />}
      <button
        type="button"
        onClick={onRefresh}
        disabled={feed.loading}
        title="Fetch again now"
        className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {feed.loading ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
      </button>
    </div>
  );
}

/**
 * The form for the secrets a widget's script needs (docs/design/widgets.md §6.5), drawn by Hangar
 * outside the widget's frame: the values go from here to the server and nowhere else.
 */
function SecretsForm({
  sessionId,
  type,
  missing,
  inProject,
  onSaved,
}: {
  sessionId: string;
  type: WidgetTypeInfo;
  missing: string[];
  inProject: boolean;
  onSaved: () => void;
}) {
  const api = useApi();
  const [values, setValues] = useState<Record<string, string>>({});
  // A personal widget may open outside any project, so its secrets are always personal.
  const [scope, setScope] = useState<"personal" | "project">("personal");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = missing.every((n) => values[n]?.trim());

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.setWidgetSecrets(
        sessionId,
        Object.fromEntries(missing.map((n) => [n, values[n].trim()])),
        type.scope === "personal" ? "personal" : scope
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void save();
      }}
    >
      <div className="flex items-start gap-2 text-sm">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p>
          <span className="font-medium">{type.title}</span> needs {missing.length === 1 ? "a secret" : "some secrets"} to
          fetch its data. They are kept on this machine, encrypted, and handed only to the widget's script — never to
          its view, and never back to any page.
        </p>
      </div>
      {missing.map((name, i) => (
        <div key={name} className="space-y-1.5">
          <Label htmlFor={`secret-${name}`} className="font-mono text-xs">
            {name}
          </Label>
          <Input
            id={`secret-${name}`}
            type={/URL|HOST|EMAIL|USER/.test(name) ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            autoFocus={i === 0}
            value={values[name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
          />
        </div>
      ))}
      {type.scope === "project" && inProject && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={scope === "project"} onChange={(e) => setScope(e.target.checked ? "project" : "personal")} />
          Only for this project (otherwise every widget of yours that asks for these names gets them)
        </label>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div>
        <Button type="submit" size="sm" disabled={!ready || saving}>
          {saving && <Loader2 className="size-3.5 animate-spin" />} Save
        </Button>
      </div>
    </form>
  );
}

/** What stands in for the view when there is nothing it could show. */
function Note({ children }: { children: ReactNode }) {
  return <div className="p-4 text-sm text-muted-foreground">{children}</div>;
}

/**
 * The inside of a widget, wherever it is drawn: the status line, then the secrets form, a note on why
 * it cannot run, or the view itself. `fit` sizes the frame to its content (a popover); otherwise it
 * fills what it is given (a tab).
 */
export function WidgetBody({
  sessionId,
  instance,
  type,
  feed,
  inProject,
  onRefresh,
  onToChat,
  onSecretsSaved,
  onSource,
  fit,
}: WidgetBodyProps & { fit?: { max: number } }) {
  const [height, setHeight] = useState(120);
  // A tab gets the zoom and reading width a file preview has. Kept per widget type, since a ticket and
  // a list of runs have different natural sizes; the reading width is the one every text preview shares.
  const [zoom, setZoom] = usePersistentZoom(`widget:${instance.type}`);
  const [readingWidth, setReadingWidth] = usePersistentReadingWidth("text");
  const missing = feed.answer?.missingSecrets?.length ? feed.answer.missingSecrets : type?.missingSecrets ?? [];

  const framed = !!type?.runnable && !(missing.length > 0 && type.source === "node");
  let inner: ReactNode;
  if (!type) inner = <Note>There is no widget “{instance.type}” for this session any more.</Note>;
  else if (!type.runnable)
    // A widget that cannot run is the one whose files most need looking at.
    inner = (
      <Note>
        <p>{type.problem ?? "This widget cannot run here."}</p>
        {onSource && (
          <div className="mt-2 text-foreground">
            <SourceButton onSource={onSource} label />
          </div>
        )}
      </Note>
    );
  else if (!framed)
    inner = (
      <SecretsForm sessionId={sessionId} type={type} missing={missing} inProject={inProject} onSaved={onSecretsSaved} />
    );
  else
    inner = (
      <WidgetFrame
        sessionId={sessionId}
        instanceId={instance.id}
        typeName={type.name}
        rev={type.rev}
        feed={feed}
        onRefresh={onRefresh}
        onToChat={onToChat}
        onHeight={fit ? setHeight : undefined}
        zoom={fit ? 1 : zoom}
        className="h-full"
      />
    );

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", !fit && "flex-1")}>
      {framed && <Status feed={feed} type={type} onRefresh={() => void onRefresh()} onSource={onSource} />}
      {/* In a popover the frame is as tall as its content asks, up to the cap; in a tab it fills. */}
      <div
        className={cn("relative min-h-0", !fit && "flex-1", framed && "overflow-hidden")}
        style={fit && framed ? { height: Math.min(Math.max(height, 60), fit.max) } : undefined}
      >
        {framed && !fit ? (
          <>
            <ZoomControls
              zoom={zoom}
              onChange={setZoom}
              width={readingWidth}
              onWidthChange={setReadingWidth}
              className="bottom-3 right-3"
            />
            {/* The cap is scaled with the zoom, so a line keeps its length at any level (READING_WIDTHS). */}
            <div className="mx-auto h-full overflow-hidden" style={{ maxWidth: readingWidth ? readingWidth * zoom : undefined }}>
              {inner}
            </div>
          </>
        ) : (
          inner
        )}
      </div>
    </div>
  );
}

/** The icon, the title and the badge: how a widget names itself on a tab or a chip. */
export function WidgetLabel({
  type,
  feed,
  compact,
  bare,
}: {
  type: WidgetTypeInfo | undefined;
  feed: WidgetFeedState;
  /** The icon and the badge only — a header chip on a phone. */
  compact?: boolean;
  /** No icon: a tab draws its own beside the label. */
  bare?: boolean;
}) {
  const Icon = widgetIcon(type?.icon);
  const title = feed.answer?.title || type?.title || "Widget";
  const badge = feed.answer?.badge;
  const error = !!(feed.answer?.error ?? feed.failure);
  return (
    <>
      {!bare && <Icon className="size-4 shrink-0" />}
      {!compact && <span className="max-w-[10rem] truncate">{title}</span>}
      {badge != null && badge !== "" && (
        <span className="max-w-[8rem] shrink-0 truncate rounded-full bg-muted px-1.5 text-[11px] leading-4 text-foreground">
          {badge}
        </span>
      )}
      {error && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" title="The last fetch failed" />}
      {feed.loading && !feed.answer && <Loader2 className="size-3 shrink-0 animate-spin opacity-60" />}
    </>
  );
}

/**
 * A widget in a popover anchored to the button that opened it — a tab-strip button or a header chip.
 * Fixed to the viewport and portalled to the body, since both kinds of anchor sit inside strips that
 * clip what overflows them. Closes on Escape and on a press outside it and its anchor.
 */
export function WidgetPopover({
  anchor,
  width,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  width?: number | null;
  onClose: () => void;
  children: (max: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; max: number } | null>(null);
  const w = Math.min(width ?? 360, window.innerWidth - 16);

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      const top = r.bottom + 4;
      setPos({ top, left, max: Math.max(120, Math.min(window.innerHeight * 0.7, window.innerHeight - top - 12)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, w]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  if (!pos) return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      className="fixed z-50 flex flex-col overflow-hidden rounded-md popover-edge bg-popover text-popover-foreground shadow-md"
      style={{ top: pos.top, left: pos.left, width: w }}
    >
      {/* What is left for the view: the popover's own title bar (32px) and the status line (28px) take the rest. */}
      {children(pos.max - 60)}
    </div>,
    document.body
  );
}
