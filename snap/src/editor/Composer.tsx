import { forwardRef, useEffect, useRef } from "react";
import clsx from "clsx";
import { Check, Clock, ExternalLink, Loader2, RefreshCw, Search, Send, Settings } from "lucide-react";
import type { ApiError, SessionItem } from "@/lib/tauri";
import { sessionColor } from "@web/lib/sessionColors";
import { ago } from "./sessions";
import { MESSAGE_MIN, PICKER_MIN } from "./Splitter";

export type SendState =
  | { kind: "idle" }
  | { kind: "sending"; postpone: boolean }
  | { kind: "sent"; postpone: boolean }
  | { kind: "error"; message: string };

export type SessionsState =
  | { kind: "loading" }
  | { kind: "ready"; items: SessionItem[] }
  | { kind: "error"; error: ApiError | string };

export const MessageBox = forwardRef<
  HTMLTextAreaElement,
  { value: string; onChange(v: string): void; target: SessionItem | null; mod: string }
>(function MessageBox({ value, onChange, target, mod }, ref) {
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={target ? `Message to ${target.name} — what should Claude look at?` : "Message to Claude…"}
      className="h-full min-h-0 w-full flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2.5 text-[13.5px] leading-relaxed outline-none placeholder:text-muted-foreground/70 focus:border-accent/70 focus:ring-2 focus:ring-accent/20"
      aria-label="Message"
      title={`${mod}↵ sends · ${mod}⇧↵ postpones · Esc leaves the box so tool keys work`}
    />
  );
});

export function SessionPicker(props: {
  state: SessionsState;
  items: SessionItem[];
  query: string;
  onQuery(q: string): void;
  selected: string | null;
  onSelect(id: string): void;
  onSend(id: string): void;
  onRetry(): void;
  onSettings(): void;
  onOpenHomeport(): void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** As dragged (see Splitter); held to what leaves the message its own minimum. */
  width: number;
  pickerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { state, items, selected } = props;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selected ?? "")}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      ref={props.pickerRef}
      style={{ width: props.width, maxWidth: `calc(100% - ${MESSAGE_MIN + 12}px)`, minWidth: PICKER_MIN }}
      className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-background"
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2.5">
        <Search size={14} className="shrink-0 text-muted-foreground" />
        <input
          ref={props.searchRef}
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          placeholder="Find a session"
          className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
          aria-label="Find a session"
        />
        <button className="text-muted-foreground hover:text-foreground" title="Refresh" onClick={props.onRetry}>
          <RefreshCw size={13} className={clsx(state.kind === "loading" && "animate-spin")} />
        </button>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label="Sessions">
        {state.kind === "loading" && items.length === 0 && <Empty>Loading sessions…</Empty>}
        {state.kind === "error" && <SessionsError error={state.error} onRetry={props.onRetry} onSettings={props.onSettings} />}
        {state.kind === "ready" && items.length === 0 && (
          <Empty>
            {props.query ? "No session matches." : "No running sessions."}
            {!props.query && (
              <button className="mt-1 flex items-center gap-1 text-accent hover:underline" onClick={props.onOpenHomeport}>
                Open Homeport <ExternalLink size={12} />
              </button>
            )}
          </Empty>
        )}
        {items.map((s, i) => (
          <SessionRow
            key={s.id}
            s={s}
            selected={s.id === selected}
            firstOfRest={i > 0 && s.lastSent == null && items[i - 1].lastSent != null}
            onClick={() => props.onSelect(s.id)}
            onDoubleClick={() => props.onSend(s.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SessionRow({
  s,
  selected,
  firstOfRest,
  onClick,
  onDoubleClick,
}: {
  s: SessionItem;
  selected: boolean;
  firstOfRest: boolean;
  onClick(): void;
  onDoubleClick(): void;
}) {
  const dot = sessionColor(s.color) ?? sessionColor(s.projectColor);
  return (
    <>
      {firstOfRest && <div className="mx-3 my-1 h-px bg-border" />}
      <div
        role="option"
        aria-selected={selected}
        data-id={s.id}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        title={`Double-click to send to ${s.name}`}
        className={clsx(
          "mx-1 flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5",
          selected ? "bg-accent/15 ring-1 ring-accent/50" : "hover:bg-muted",
        )}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: dot ?? "var(--muted-foreground)", opacity: dot ? 1 : 0.35 }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{s.name}</span>
            {s.busy && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-ok" title="Claude is working" />}
          </div>
          <div className="truncate text-[11.5px] text-muted-foreground">
            {s.project ? `${s.project} · ${s.folder}` : s.folder}
          </div>
        </div>
        {s.lastSent != null && <span className="shrink-0 text-[11px] text-muted-foreground">{ago(s.lastSent)}</span>}
      </div>
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center px-4 py-6 text-center text-muted-foreground">{children}</div>;
}

function SessionsError({ error, onRetry, onSettings }: { error: ApiError | string; onRetry(): void; onSettings(): void }) {
  const unauthorized = typeof error !== "string" && error.kind === "unauthorized";
  const message = typeof error === "string" ? error : unauthorized ? "Sign in to the Homeport server to see its sessions." : error.message;
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-5 text-center">
      <p className="text-muted-foreground">{message}</p>
      <div className="flex gap-2">
        {!unauthorized && (
          <button className="rounded-md border border-border px-2.5 py-1 hover:bg-muted" onClick={onRetry}>
            Retry
          </button>
        )}
        <button
          className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-accent-foreground hover:opacity-90"
          onClick={onSettings}
        >
          <Settings size={13} /> {unauthorized ? "Sign in" : "Settings"}
        </button>
      </div>
    </div>
  );
}

export function SendBar(props: {
  target: SessionItem | null;
  send: SendState;
  onSend(): void;
  onPostpone(): void;
  mod: string;
  hint?: string;
}) {
  const { target, send } = props;
  const busy = !target || send.kind === "sending" || send.kind === "sent";
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 truncate text-[12px]">
        {send.kind === "error" ? (
          <span className="text-danger">{send.message}</span>
        ) : (
          <span className="text-muted-foreground">{props.hint}</span>
        )}
      </div>
      {/* Into the session's postponed messages, to go when it is free (or by its auto-send). */}
      <button
        onClick={props.onPostpone}
        disabled={busy}
        title={`Add to the session's postponed messages instead of sending now (${props.mod}⇧↵)`}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] text-foreground hover:bg-muted disabled:cursor-default disabled:opacity-50"
      >
        {send.kind === "sending" && send.postpone ? <Loader2 size={14} className="animate-spin" /> : <Clock size={14} />}
        Postpone
      </button>
      <button
        onClick={props.onSend}
        disabled={busy}
        className={clsx(
          // min-w-0: on a narrow message column the session name gives way, not the edge of the column.
          "flex h-9 min-w-0 max-w-[340px] items-center gap-2 rounded-lg px-4 font-medium text-white shadow-sm transition disabled:cursor-default",
          send.kind === "sent" ? "bg-ok" : "bg-accent hover:brightness-105 disabled:opacity-50",
        )}
      >
        {send.kind === "sending" && !send.postpone ? (
          <Loader2 size={15} className="shrink-0 animate-spin" />
        ) : send.kind === "sent" ? (
          <Check size={15} className="shrink-0" />
        ) : (
          <Send size={15} className="shrink-0" />
        )}
        <span className="truncate">
          {send.kind === "sent"
            ? send.postpone
              ? `Postponed for ${target?.name ?? "the session"}`
              : "Sent"
            : target
              ? `Send to ${target.name}`
              : "Choose a session"}
        </span>
        {send.kind !== "sent" && target && <kbd className="shrink-0 border-white/30 bg-white/15 text-white">{props.mod}↵</kbd>}
      </button>
    </div>
  );
}
