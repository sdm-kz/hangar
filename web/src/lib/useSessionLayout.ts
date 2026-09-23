// The session pane's layout as React state: restored from the session's saved bag and written back on
// every change. Nothing here guards unsaved edits: a file preview with edits stays mounted whether or
// not its tab is on screen (see SessionView), so hiding it loses nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import { loadSessionUi, saveSessionUi, subscribeSessionUi } from "./sessionUi";
import { findGroup, groupsOf, parseLayout, type PaneLayout, type PaneRef } from "./layout";

/**
 * The tabs actually on screen. Wide, that is every group's active tab (only the zoomed group's, when
 * one is zoomed); narrow, the groups fold into one strip and only the focused group is drawn.
 */
export function visibleRefs(layout: PaneLayout, wide: boolean): PaneRef[] {
  const gs = groupsOf(layout.root);
  const shown = !wide ? gs.filter((g) => g.id === layout.active) : layout.max ? gs.filter((g) => g.id === layout.max) : gs;
  return shown.flatMap((g) => (g.active ? [g.active] : []));
}

export interface SessionLayout {
  layout: PaneLayout;
  /** Change the layout now. `persist: false` for the in-between steps of a drag. */
  update: (fn: (l: PaneLayout) => PaneLayout, persist?: boolean) => void;
  /** The latest layout, readable from inside a callback without waiting for a render. */
  current: () => PaneLayout;
  /**
   * Bumped when the server's copy arrives. Until it has, this device's own guess at a layout is not
   * worth saving over one another device left there — see `seeded`.
   */
  seedTick: number;
  seeded: () => boolean;
}

export function useSessionLayout(
  sessionId: string,
  initial: () => PaneLayout
): SessionLayout {
  const [layout, setLayout] = useState<PaneLayout>(() => parseLayout(loadSessionUi(sessionId).layout) ?? initial());
  // Mirrored so several changes made in one click build on each other rather than on the render.
  const ref = useRef(layout);
  const [seedTick, setSeedTick] = useState(0);
  const seededRef = useRef(false);

  const update = useCallback(
    (fn: (l: PaneLayout) => PaneLayout, persist = true) => {
      const next = fn(ref.current);
      if (next === ref.current) return;
      ref.current = next;
      setLayout(next);
      if (persist) saveSessionUi(sessionId, { layout: next });
    },
    [sessionId]
  );

  // The copy fetched when the session is opened is the arrangement it was left in, on whichever
  // device that was. A later write from another device is not taken: what is on screen here is the
  // choice of whoever is in front of this one, the same rule the tab bar's view always followed.
  useEffect(
    () =>
      subscribeSessionUi(sessionId, (seed) => {
        if (!seed) return;
        seededRef.current = true;
        // Whatever arrives, the tabs it names are checked against the tabs that exist.
        setSeedTick((t) => t + 1);
        const saved = parseLayout(loadSessionUi(sessionId).layout);
        if (!saved) return;
        // Keep the focus here if the group it is on is still there — it says where the person is.
        const active = findGroup(saved, ref.current.active) ? ref.current.active : saved.active;
        ref.current = { ...saved, active };
        setLayout(ref.current);
      }),
    [sessionId]
  );

  const current = useCallback(() => ref.current, []);
  const seeded = useCallback(() => seededRef.current, []);
  return { layout, update, current, seedTick, seeded };
}
