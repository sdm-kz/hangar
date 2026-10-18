import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Check, Loader2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { api, apiErrorText, type ConnectionStatus, type Hotkeys, type Mode, type SettingsView } from "@/lib/tauri";
import { comboFrom, displayCombo } from "./hotkeys";

const isMac = navigator.userAgent.includes("Mac");

const MODES: { mode: Mode; key: keyof Hotkeys; label: string; detail: string }[] = [
  { mode: "region", key: "region", label: "Region", detail: "Drag a rectangle, or click a window" },
  { mode: "window", key: "window", label: "Window", detail: "Click the window to take" },
  { mode: "fullscreen", key: "fullscreen", label: "Full screen", detail: "The screen under the pointer" },
  { mode: "freeform", key: "freeform", label: "Freeform", detail: "Trace any shape" },
];

export default function Settings() {
  const [saved, setSaved] = useState<SettingsView | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [hotkeys, setHotkeys] = useState<Hotkeys | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus | "checking" | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const savedRef = useRef<SettingsView | null>(null);
  savedRef.current = saved;

  const adopt = (s: SettingsView) => {
    setSaved(s);
    setServerUrl(s.serverUrl);
    setHotkeys(s.hotkeys);
    setAutostart(s.autostart);
  };

  const check = useCallback(() => {
    setStatus("checking");
    api.connectionStatus().then(setStatus, (e) => setStatus({ ok: false, local: false, authRequired: false, error: { kind: "failed", message: String(e) } }));
  }, []);

  useEffect(() => {
    api.getSettings().then(adopt);
    check();
    // Changed from elsewhere (the tray's "Start when I sign in", a save): take what was changed there,
    // leaving any unsaved edits here alone.
    const un = listen("settings-changed", () =>
      api.getSettings().then((s) => {
        if (savedRef.current && savedRef.current.autostart !== s.autostart) setAutostart(s.autostart);
        setSaved(s);
      }),
    );
    return () => void un.then((f) => f());
  }, [check]);

  if (!saved || !hotkeys) return null;

  const changed =
    serverUrl.trim().replace(/\/+$/, "") !== saved.serverUrl ||
    autostart !== saved.autostart ||
    MODES.some((m) => hotkeys[m.key] !== saved.hotkeys[m.key]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      adopt(await api.saveSettings({ serverUrl, hotkeys, autostart }));
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1500);
      check();
    } catch (e) {
      setError(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.signIn(password);
      setPassword("");
      setSaved(await api.getSettings());
      check();
    } catch (e) {
      setError(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await api.signOut();
    setSaved(await api.getSettings());
    check();
  };

  const st = status === "checking" ? null : status;
  const needsSignIn = !!st && !st.ok && !st.local && st.error?.kind === "unauthorized";

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        <header>
          <h1 className="text-[17px] font-semibold">Hangar Snap</h1>
          <p className="text-muted-foreground">
            Take a screenshot, mark it up, and send it to a Claude session with a message.
          </p>
        </header>

        <Section title="Server">
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Hangar address</span>
            <input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              spellCheck={false}
              className="h-8 w-full rounded-md border border-border bg-background px-2.5 outline-none focus:border-accent/70 focus:ring-2 focus:ring-accent/20"
              placeholder="http://127.0.0.1:5099"
            />
          </label>
          <div className="flex items-center gap-2 text-[12.5px]">
            <StatusDot status={status} />
            <span className="min-w-0 flex-1 truncate">
              {status === "checking"
                ? "Checking…"
                : !st
                  ? ""
                  : st.ok
                    ? st.local
                      ? "Connected to the Hangar on this computer — no sign-in needed."
                      : st.authRequired
                        ? "Connected and signed in."
                        : "Connected."
                    : needsSignIn
                      ? "This server needs its password."
                      : apiErrorText(st.error)}
            </span>
            <button className="text-muted-foreground hover:text-foreground" onClick={check}>
              Check again
            </button>
          </div>
          {needsSignIn && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void signIn();
              }}
            >
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Hangar password"
                autoFocus
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 outline-none focus:border-accent/70 focus:ring-2 focus:ring-accent/20"
              />
              <button
                type="submit"
                disabled={!password || busy}
                className="h-8 rounded-md bg-accent px-3 font-medium text-accent-foreground disabled:opacity-50"
              >
                Sign in
              </button>
            </form>
          )}
          {st?.ok && !st.local && saved.signedIn && (
            <button className="text-[12.5px] text-muted-foreground underline-offset-2 hover:underline" onClick={() => void signOut()}>
              Sign out
            </button>
          )}
        </Section>

        <Section title="Hotkeys">
          <div className="divide-y divide-border rounded-lg border border-border">
            {MODES.map((m) => (
              <div key={m.mode} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{m.label}</div>
                  <div className="text-[12px] text-muted-foreground">{m.detail}</div>
                </div>
                <HotkeyField value={hotkeys[m.key]} onChange={(v) => setHotkeys({ ...hotkeys, [m.key]: v })} />
                <button
                  className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => void api.startCapture(m.mode)}
                  title="Take one now"
                >
                  Try
                </button>
              </div>
            ))}
          </div>
          {saved.hotkeyErrors.map((e) => (
            <p key={e} className="text-[12.5px] text-danger">
              {e}
            </p>
          ))}
          <PlatformNote platform={saved.platform} />
        </Section>

        <Section title="General">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} className="accent-[var(--accent)]" />
            Start when I sign in
          </label>
        </Section>
      </div>
      <footer className="flex items-center gap-3 border-t border-border bg-panel px-5 py-3">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-danger">{error}</span>
        {justSaved && (
          <span className="flex items-center gap-1 text-[12.5px] text-ok">
            <Check size={14} /> Saved
          </span>
        )}
        <button
          onClick={() => void save()}
          disabled={!changed || busy}
          className="flex h-8 items-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-foreground disabled:opacity-40"
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          Save
        </button>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function StatusDot({ status }: { status: ConnectionStatus | "checking" | null }) {
  if (status === "checking") return <Loader2 size={12} className="animate-spin text-muted-foreground" />;
  return <span className={clsx("h-2 w-2 shrink-0 rounded-full", status?.ok ? "bg-ok" : "bg-danger")} />;
}

/** Click, then press the keys. Backspace clears it; Esc keeps what was there. */
function HotkeyField({ value, onChange }: { value: string; onChange(v: string): void }) {
  const [recording, setRecording] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!recording) return;
    // The app's own hotkeys would fire instead of reaching this page.
    void api.suspendHotkeys(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(false);
      if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        onChangeRef.current("");
        return setRecording(false);
      }
      const combo = comboFrom(e, isMac);
      if (combo) {
        onChangeRef.current(combo);
        setRecording(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      void api.suspendHotkeys(false);
    };
  }, [recording]);

  return (
    <button
      onClick={() => setRecording((r) => !r)}
      onBlur={() => setRecording(false)}
      className={clsx(
        "h-8 min-w-[140px] rounded-md border px-2.5 text-[12.5px] tabular-nums",
        recording ? "border-accent bg-accent/10 text-accent" : "border-border bg-background hover:bg-muted",
      )}
      title="Click, then press the new keys (Backspace for none)"
    >
      {recording ? "Press keys…" : value ? displayCombo(value, isMac) : <span className="text-muted-foreground">None</span>}
    </button>
  );
}

function PlatformNote({ platform }: { platform: string }) {
  if (platform === "macos") {
    return (
      <p className="text-[12px] text-muted-foreground">
        macOS asks once for <b>Screen Recording</b> permission (System Settings → Privacy &amp; Security). Snap needs it to see
        anything but the desktop wallpaper.
      </p>
    );
  }
  if (platform === "linux") {
    return (
      <p className="text-[12px] text-muted-foreground">
        On Wayland, apps can't register global hotkeys. Bind <code>hangar-snap --capture region</code> (or <code>window</code>,{" "}
        <code>fullscreen</code>, <code>freeform</code>) in your desktop's keyboard settings instead.
      </p>
    );
  }
  return null;
}
