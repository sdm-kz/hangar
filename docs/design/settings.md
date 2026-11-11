# Settings: one place to administer Hangar

**Goal.** One Settings dialog that holds everything global: the look, notifications, the machines
this one is paired with, projects, schedules, the password, Claude's hooks and updates, with a
search box over all of it. Today these are spread over about nine buttons and strips, each with its
own popup. `multi-node.md` (§3, §9) already speaks of "Settings → Nodes" as if a Settings area
existed. It doesn't: that is the Nodes button in the footer.

**Non-goal.** Moving the controls you use in passing. The project gear, New project, Schedules, the
light/dark switch, the push bell, Update and the two warning strips all stay where they are. Settings
*also* reaches them, for administering everything in one sitting, but it isn't the only way in. Also
not a goal: putting the other `appsettings.json`-only options (`Hooks:Enabled`, `Ui:Themes`) into
the UI. Settings gives them a place to go later; v1 links to the docs instead. Changing a password
that is already set is the one exception, and it ships in v1 (§6).

---

## 1. What there is today

| Configures | Opened from | Kept there? |
| --- | --- | --- |
| Nodes (this node, peers, allowed in) | `Network` icon, sidebar footer | **no** → Settings |
| Themes (mode, library, editor) | `Palette` icon, sidebar footer | **no** → Settings |
| Light/dark switch | `Sun`/`Moon`, sidebar footer | yes |
| Push notifications | Bell, sidebar footer | yes |
| Update | Sky-blue button, footer / peer heading | yes |
| First password | Blue strip under the header | yes |
| Hooks ownership | Amber strip under the header | yes |
| Projects | New project (toolbar), gear on each heading | yes |
| Schedules | `CalendarClock`, Sessions toolbar | yes |

The footer goes from Sign out · Nodes · … · Update · Bell · Palette · Sun to Sign out ·
**Settings** · … · Update · Bell · Sun. Nodes and Themes are the only two whose button goes away:
neither is something you open in passing.

## 2. The dialog

`ProjectDialog`'s layout, already proven on desktop and phone: one fixed height, capped to the
viewport; tabs down the left (a sideways-scrolling strip across the top below `sm`); the chosen tab's
panel on the right, which is what scrolls; arrow keys and Home/End along the tabs; changes save as
you make them, so there is no Apply. The search box sits above the tab list.

| Tab | Scope | Content | Built from |
| --- | --- | --- | --- |
| Appearance | browser + shared | Mode, light/dark theme picks, custom theme editor | `ThemeDialog` body |
| Notifications | browser | Push on/off, and why not when blocked or not installed | `NotificationToggle` states |
| Nodes | this node | This node, nodes it reaches, allowed in, add node | `NodesDialog` body |
| Projects | node | Every project: name, folders, repo count; New; each opens `ProjectDialog` | new list + existing dialog |
| Schedules | node | The schedule list and editor | `ScheduleDialog` body |
| Security | this node | Set the first password, or change the one that is set; Sign out | `SetPasswordDialog` form |
| Hooks | node | Who owns the hooks, always (ours, elsewhere, off, failed); Take them over | `HooksWarning` logic |
| Updates | every node | Running and staged build per node, what's new, Update and restart | `UpdateButton` parts |

Projects is a list, not the editor. The editor already has six tabs, and tabs inside tabs is the
mess that keeping `ProjectDialog` separate avoids. Clicking a project (or New project) opens the
same `ProjectDialog` the sidebar opens, on top of Settings.

## 3. Scope: this browser, or which machine

Some settings live in the browser (theme mode and picks, push subscription); some on a machine
(projects, schedules, password, hooks, nodes). Custom theme colours are on the server but shared by
every browser signed in there. With peers paired, "which machine" has to be visible, or a change
lands on the wrong one (`multi-node.md` §8: what is per node must look per node).

- Every panel's heading carries a scope line: *This browser*, or *Node: kitchen-server*.
- Node-scoped tabs (Projects, Schedules, Hooks) get the node picker `ScheduleDialog` already has,
  and render inside that node's `NodeProvider`. The picked node is kept across tabs.
- Nodes and Security are always this node's view. Pairing is between two machines, each managing
  its own end, and `/api/auth` is never proxied (`NodeProxy.LocalOnly`): a peer's password is
  changed by signing in to that peer, not through this one.
- Updates lists every node at once. It's the one place an out-of-date peer can't hide.

## 4. Search

A filter box at the top of the tab column, focused when Settings opens (not on a phone, where the
keyboard would cover the panel).

- **Index.** A static registry, one entry per setting a person might look for:
  `{ id, tab, title, keywords[], scope }`, such as `{ id: "nodes.url", tab: "nodes", title: "Address
  for other nodes", keywords: ["url", "pairing", "host"] }`. Each panel marks the matching element
  with `data-setting="nodes.url"`. Next to it, entries made from live data: project names, node
  names, theme names, schedule names, so "kitchen" finds the node and "deploy" the schedule.
- **Matching.** Case-insensitive; every word typed must appear in the title, keywords or tab label.
  Title matches rank above keyword matches, and a match at the start of a word ranks first.
- **Results.** While the box has text, the results take the place of the tabs and the panel (which
  stay mounted underneath, so nothing typed into a panel is lost), best match first, each naming its
  tab, with the matched words highlighted. Up/Down move through it and Enter opens one. With no matches it
  says so, and offers the docs' configuration page for settings that exist only in a file.
- **Opening a result.** Switch to its tab (and node, for live entries), scroll its `data-setting`
  element into view, and flash it briefly. A live project entry opens that project's dialog.
- Escape clears the box first, and closes Settings second.

## 5. Opening it

`useSettings().open(tab?, setting?)` (`lib/settings.ts`) from one provider at the app level, so
anything can deep-link: the gear, a future command palette, a "Settings → Nodes" link in a hint.
Search results open through the same path. The strips and the footer's bell keep their own buttons,
and read their state again when Settings closes, so a password set or hooks taken over there show
at once.

**`Ctrl+Shift+S`** (`⌘⇧S` on a Mac) opens it from anywhere, handled like session search's
`Ctrl+Shift+F` (`App.tsx`): a capture-phase listener with `stopPropagation`, so it wins while a
terminal has focus. A terminal can't send Ctrl+Shift+S distinctly from Ctrl+S anyway, and plain
Ctrl+S (XOFF, or a TUI's save) is left alone. `Ctrl+,` was the other candidate, but `⌘,` opens the
browser's own preferences on macOS, and the two shortcuts sit better as a pair. Known clashes: Firefox
(Screenshots) and Edge (Web capture) bind Ctrl+Shift+S. Neither is among the shortcuts a browser
keeps from pages (new tab, close tab, new window), so the page's `preventDefault` should win, but
that needs checking in each. Where it doesn't, the browser's feature opens instead of Settings, and
the gear still works.

## 6. Building it

1. The dialogs whose bodies move become panels: `NodesPanel` and `ThemePanel` (their buttons are
   gone, so their dialogs went with them), and `SchedulesPanel` inside `ScheduleDialog`, which keeps
   working as before, so the toolbar's Schedules button is unchanged.
2. `SettingsDialog.tsx`, laid out as `ProjectDialog` is, and `lib/settings.ts` (the tabs, the
   registry, the search, the opener).
3. New small panels (`SettingsPanels.tsx`, `NotificationsPanel`): Projects, Notifications, Security,
   Hooks, Updates. Hooks and Security use the API calls the strips already make. Updates reuses
   `UpdateButton` and `BuildLine`.
4. Footer: the gear in place of the Nodes and Palette icons.
5. One server change: changing the password (below). Every other panel uses endpoints that exist.

### Changing the password

`POST /api/auth/password/change` with `{ current, password }`, next to the first-password endpoint.

- **Who may.** Any signed-in browser, on this machine or not: knowing the current password is the
  check, not where the request comes from. A browser that was left signed in isn't enough to lock
  its owner out, which is why setting a password over one that exists had stayed config-only.
- **Throttled** by `LoginThrottle`, shared with the login and pairing. A wrong `current` is a guess
  at the same password, and without the throttle this endpoint would be a way to guess it unthrottled.
- **Refused** (409) while no password is set (that's `POST /api/auth/password`'s job), and while
  `Auth:Password` holds a plaintext: that one wins on every start (`TokenStore`'s constructor), so a
  change from the page would quietly undo itself at the next restart. The error says to remove it.
- **Same rules** as the first password: at least 8 characters, at most 1024.
- **Afterwards** every browser token is dropped and the caller gets a new one, as
  `SetFirstPassword` does. A changed password usually means "someone else may have had it", and
  their browsers shouldn't stay in. Peer tokens (`PeerTokenStore`) are kept: the machines paired with
  this one hold a token of their own, not the password, so pairing doesn't break.
- `TokenStore.ChangePassword(current, next)`: verify, hash, and change nothing unless the hash
  reaches `auth.json`, under the same lock as `SetFirstPassword`.

## 7. Open questions

- **Sign out** stays in the footer, and Security repeats it; it costs nothing.
- **Sign out everywhere** without changing the password: the same token drop, as a button. Cheap
  once the change exists; not v1 unless it falls out of it.
- **Per-view options** (zoom, wrap, line numbers) stay per view; they aren't global.
- **The tray's settings** (screenshot hotkeys, Hangar address) live in its own window, not here.
