import { Fragment } from "react";
import { IS_MAC, SHORTCUT_GROUPS, keyName, type Key } from "@/lib/shortcuts";

/**
 * Settings → Shortcuts: every keyboard shortcut, grouped by where it works, with this platform's names
 * for the keys (⌘ on a Mac). Each row is a search target (`data-setting`), so the search box finds a
 * shortcut by what it does or by its keys.
 */
export function ShortcutsPanel() {
  return (
    <div className="flex flex-col gap-5" data-setting="shortcuts.list">
      <p className="text-xs text-muted-foreground">
        {IS_MAC && "⌘ is Command, ⌥ Option, ⇧ Shift and ⌃ Control. "}
        Press <Kbd k="?" /> outside a text box to come back here.
      </p>
      {SHORTCUT_GROUPS.map((g) => (
        <section key={g.id} className="flex flex-col gap-1.5">
          <h4 className="text-sm font-medium">{g.title}</h4>
          {g.where && <p className="text-xs text-muted-foreground">{g.where}</p>}
          <ul className="flex flex-col divide-y rounded-md border">
            {g.shortcuts.map((s) => (
              <li
                key={s.id}
                data-setting={`shortcut:${g.id}.${s.id}`}
                className="flex flex-col gap-1 px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
              >
                <div className="min-w-0">
                  <p className="text-sm">{s.does}</p>
                  {s.note && <p className="text-xs text-muted-foreground">{s.note}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                  {s.keys.map((chord, i) => (
                    <Fragment key={i}>
                      {i > 0 && <span>or</span>}
                      <Chord keys={chord} />
                    </Fragment>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Chord({ keys }: { keys: Key[] }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((k, i) => (
        <Kbd key={i} k={k} />
      ))}
    </span>
  );
}

function Kbd({ k }: { k: Key }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border bg-muted px-1.5 py-0.5 font-sans text-[11px] font-medium leading-none text-foreground shadow-[inset_0_-1px_0_var(--border)]">
      {keyName(k)}
    </kbd>
  );
}
