// The widgets open in a session (docs/design/widgets.md): which instances there are, the types they
// are instances of, and the data each one shows.
//
// The instances live in the session's UI bag, keyed by conversation, like pinned links and reviews
// (lib/sessionLinks.ts), so they follow the session to every device and survive a reopen — and so
// POST /api/self/widget can open one from inside the session by writing the same field. An instance
// stores only the params it was GIVEN: one read from the session (its name, its branch) stays linked
// and is resolved again by the server on every fetch.
//
// The types come from the server and move with the session hub's `widgetsRev`; the data is fetched
// per instance by one feed each (useWidgetFeeds), which polls only while the instance can be seen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "./api";
import type { WidgetDataAnswer, WidgetInstance, WidgetPlacement, WidgetTypeInfo, WidgetTypesAnswer } from "@/types";
import { loadSessionUi, saveSessionUi, subscribeSessionUi } from "./sessionUi";

/** How many widgets a session may have open — the cap POST /api/self/widget keeps too (SessionManager). */
export const MAX_WIDGETS = 16;

const PLACEMENTS: WidgetPlacement[] = ["tab", "tab-popover", "header"];

function restore(sessionId: string): { instances: WidgetInstance[]; shown: string | null; shownAt: number } {
  const ui = loadSessionUi(sessionId);
  const list = Array.isArray(ui.widgets) ? (ui.widgets as unknown[]) : [];
  const instances = list.filter(
    (w): w is WidgetInstance =>
      !!w &&
      typeof (w as WidgetInstance).id === "string" &&
      typeof (w as WidgetInstance).type === "string" &&
      PLACEMENTS.includes((w as WidgetInstance).placement) &&
      typeof ((w as WidgetInstance).params ?? {}) === "object"
  ).map((w) => ({ ...w, params: w.params ?? {} }));
  const shown = typeof ui.widget === "string" && instances.some((w) => w.id === ui.widget) ? (ui.widget as string) : null;
  return { instances, shown, shownAt: typeof ui.widgetAt === "number" ? ui.widgetAt : 0 };
}

function mintId(): string {
  return "w" + (crypto.randomUUID?.().replace(/-/g, "").slice(0, 12) ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
}

/** The same type, given the same params, in the same place: one instance, opened twice. */
export function sameInstance(a: Omit<WidgetInstance, "id">, b: Omit<WidgetInstance, "id">): boolean {
  const canon = (p: Record<string, unknown>) =>
    JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]));
  return a.type.toLowerCase() === b.type.toLowerCase() && a.placement === b.placement && canon(a.params) === canon(b.params);
}

export interface SessionWidgets {
  instances: WidgetInstance[];
  /** The instance last opened to be looked at (by the dialog or the self API): a tab is shown when it lands. */
  shown: string | null;
  /**
   * When the self API last asked for `shown` to be looked at. It moves even when the instance was open
   * already, which is what brings an open tab forward again.
   */
  shownAt: number;
  /** Open one, or go back to the same one already open. */
  open: (w: Omit<WidgetInstance, "id">) => WidgetInstance;
  update: (id: string, patch: Partial<Omit<WidgetInstance, "id">>) => void;
  remove: (id: string) => void;
}

/** Own a session's open widgets: the list, and keeping it in the shared bag. */
export function useSessionWidgets(sessionId: string): SessionWidgets {
  const [state, setState] = useState(() => restore(sessionId));
  const ref = useRef(state);

  const apply = useCallback(
    (next: { instances: WidgetInstance[]; shown: string | null; shownAt: number }) => {
      ref.current = next;
      setState(next);
      saveSessionUi(sessionId, { widgets: next.instances, widget: next.shown ?? "" });
    },
    [sessionId]
  );

  const open = useCallback(
    (w: Omit<WidgetInstance, "id">) => {
      const existing = ref.current.instances.find((x) => sameInstance(x, w));
      if (existing) {
        apply({ ...ref.current, shown: existing.id });
        return existing;
      }
      const created: WidgetInstance = { ...w, id: mintId() };
      apply({ ...ref.current, instances: [...ref.current.instances, created].slice(-MAX_WIDGETS), shown: created.id });
      return created;
    },
    [apply]
  );

  const update = useCallback(
    (id: string, patch: Partial<Omit<WidgetInstance, "id">>) =>
      apply({ ...ref.current, instances: ref.current.instances.map((w) => (w.id === id ? { ...w, ...patch } : w)) }),
    [apply]
  );

  const remove = useCallback(
    (id: string) => {
      const instances = ref.current.instances.filter((w) => w.id !== id);
      apply({ ...ref.current, instances, shown: ref.current.shown === id ? null : ref.current.shown });
    },
    [apply]
  );

  // Another session (or this one, from inside, through the self API) wrote the list: take it.
  const prev = useRef(sessionId);
  useEffect(() => {
    if (prev.current === sessionId) return;
    prev.current = sessionId;
    const next = restore(sessionId);
    ref.current = next;
    setState(next);
  }, [sessionId]);
  useEffect(
    () =>
      subscribeSessionUi(sessionId, () => {
        const next = restore(sessionId);
        ref.current = next;
        setState(next);
      }),
    [sessionId]
  );

  return useMemo(
    () => ({ instances: state.instances, shown: state.shown, shownAt: state.shownAt, open, update, remove }),
    [state, open, update, remove]
  );
}

/** The widget types a session can open, re-read whenever the node says one was written. */
export function useWidgetTypes(api: Api, sessionId: string, widgetsRev: number) {
  const [answer, setAnswer] = useState<WidgetTypesAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api
      .sessionWidgets(sessionId)
      .then((a) => {
        if (!live) return;
        setAnswer(a);
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [api, sessionId, widgetsRev, tick]);

  // By name, as an instance refers to its type: the one that opens (a shadowed personal one doesn't).
  const byName = useMemo(() => {
    const m = new Map<string, WidgetTypeInfo>();
    for (const t of answer?.types ?? []) if (!t.shadowed) m.set(t.name.toLowerCase(), t);
    return m;
  }, [answer]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { answer, byName, failed, reload };
}

/** What one instance's feed has: the server's last answer, and whether a fetch is running now. */
export interface WidgetFeedState {
  answer: WidgetDataAnswer | null;
  loading: boolean;
  /** The call itself failed — the server unreachable, the session gone — as opposed to the source. */
  failure: string | null;
}

const IDLE: WidgetFeedState = { answer: null, loading: true, failure: null };

/**
 * One instance's data: what the cache has at once, then a fetch if that is stale, then — while the
 * instance can be seen — again at the type's refresh interval. Forced runs join one already going.
 */
class Feed {
  state: WidgetFeedState = IDLE;
  private ctrl = new AbortController();
  private running: Promise<WidgetFeedState> | null = null;
  private runningMode: "cached" | "ifStale" | "force" | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private live = false;

  constructor(
    private readonly fetch: (mode: "cached" | "ifStale" | "force", signal: AbortSignal) => Promise<WidgetDataAnswer>,
    private readonly every: number | null,
    private readonly onChange: () => void
  ) {}

  private set(patch: Partial<WidgetFeedState>) {
    this.state = { ...this.state, ...patch };
    this.onChange();
  }

  /** Fetch; resolves to the state once the answer is in it. */
  run(mode: "cached" | "ifStale" | "force"): Promise<WidgetFeedState> {
    // Joined: anything but a forced run joins the one going, and a forced run joins a forced one. A
    // forced run after a lesser one waits for it to finish rather than racing it.
    if (this.running && (mode !== "force" || this.runningMode === "force")) return this.running;
    const before = this.running ?? Promise.resolve(this.state);
    const go = before.then(async () => {
      if (this.ctrl.signal.aborted) return this.state;
      if (mode !== "cached") this.set({ loading: true });
      try {
        const answer = await this.fetch(mode, this.ctrl.signal);
        if (this.ctrl.signal.aborted) return this.state;
        // A cached answer with nothing in it yet is not the end of loading: the real fetch is next.
        const empty = mode === "cached" && answer.data == null && !answer.error && !answer.needsParams;
        this.set({ answer: empty && this.state.answer ? this.state.answer : answer, loading: empty, failure: null });
      } catch (e) {
        if (this.ctrl.signal.aborted) return this.state;
        this.set({ loading: false, failure: e instanceof Error ? e.message : String(e) });
      }
      return this.state;
    });
    const tracked: Promise<WidgetFeedState> = go.finally(() => {
      if (this.running === tracked) {
        this.running = null;
        this.runningMode = null;
      }
    });
    this.running = tracked;
    this.runningMode = mode;
    return tracked;
  }

  /**
   * What the cache has, at once — and a fetch only for an instance that can be seen. A tab behind
   * another is fetched when it is first shown, so opening a session with several claude widgets in
   * hidden tabs does not set them all running.
   */
  start() {
    void this.run("cached").then(() => {
      if (this.live) void this.run("ifStale");
    });
  }

  setLive(live: boolean) {
    if (live === this.live) return;
    this.live = live;
    clearInterval(this.timer);
    this.timer = undefined;
    if (!live) return;
    // Coming into view: fetch if the data is missing or went stale meanwhile, then keep it fresh.
    void this.run("ifStale");
    if (this.every) this.timer = setInterval(() => void this.run("ifStale"), this.every * 1000);
  }

  dispose() {
    this.ctrl.abort();
    clearInterval(this.timer);
  }
}

/**
 * The data of every open instance, one feed each, keyed by instance id. A feed starts afresh when its
 * type is rewritten (its rev moves) or its params change; `isLive` says which can be seen right now —
 * only those poll.
 */
export function useWidgetFeeds(
  api: Api,
  sessionId: string,
  instances: WidgetInstance[],
  types: Map<string, WidgetTypeInfo>,
  isLive: (w: WidgetInstance) => boolean
) {
  const feeds = useRef(new Map<string, { feed: Feed; sig: string }>());
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const sigs = instances.map((w) => {
    const t = types.get(w.type.toLowerCase());
    // updatedAt as well as rev: a type deleted and written again starts at rev 1 again.
    return { w, t, sig: t && t.runnable ? `${t.scope}|${t.rev}|${t.updatedAt}|${JSON.stringify(w.params)}` : "" };
  });
  const key = sigs.map((s) => `${s.w.id}=${s.sig}`).join("\n");

  useEffect(() => {
    const map = feeds.current;
    const keep = new Set<string>();
    for (const { w, t, sig } of sigs) {
      if (!t || !sig) continue;
      keep.add(w.id);
      const had = map.get(w.id);
      if (had?.sig === sig) continue;
      had?.feed.dispose();
      const params = w.params;
      const feed = new Feed(
        (mode, signal) => api.widgetData(sessionId, t.name, { params, mode, instance: w.id }, signal),
        t.refreshSeconds ?? null,
        bump
      );
      map.set(w.id, { feed, sig });
      feed.start();
    }
    for (const [id, f] of map)
      if (!keep.has(id)) {
        f.feed.dispose();
        map.delete(id);
      }
    bump();
    // `sigs` is read through its key: a new array holding the same instances is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionId, key, bump]);

  useEffect(() => () => {
    for (const f of feeds.current.values()) f.feed.dispose();
    feeds.current.clear();
  }, []);

  // Which may poll: every render, since what is on screen changes without the instances changing.
  useEffect(() => {
    for (const w of instances) feeds.current.get(w.id)?.feed.setLive(isLive(w));
  });

  const state = (id: string): WidgetFeedState => feeds.current.get(id)?.feed.state ?? IDLE;
  const refresh = useCallback(
    (id: string): Promise<WidgetFeedState | undefined> => feeds.current.get(id)?.feed.run("force") ?? Promise.resolve(undefined),
    []
  );
  return { state, refresh };
}
