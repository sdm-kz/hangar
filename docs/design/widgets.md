# Widgets: small live views a session can open on anything

**Goal.** A session can show a live view of something outside the repo — a Jira ticket, the
tickets in progress, the time logged today, the last runs of a GitHub workflow — as a tab in its tab
strip, as a button in the tab strip that opens a popover, or as a chip in its header. What the view
shows, where its data comes from and what buttons it has is described once, as a **widget type**,
and opened in any session: from the **+** menu, or by Claude with `hgr-open-tab jira-ticket
key=PROJ-123`.

Widget types are **written by Claude, through a Hangar API**, from a prompt typed in any Claude
session Hangar runs:

> create a widget that lists my Jira tickets in progress, as a tab that opens a popup, refreshing
> every 30 seconds, using a Jira API key

Hangar serves the schema, the rules and worked examples to that session, validates what Claude
writes, runs it as a test, and opens it. Changing a widget later is another prompt: "make the status
a coloured pill".

**Non-goal.** A plugin system for Hangar itself: a widget cannot change Hangar's UI outside its own
frame, register routes or read other sessions. Not a goal either: a visual dashboard builder, or a
marketplace. A widget is a folder of three or four small files.

---

## 1. Why this, and not a pinned link

Pinned web pages (`WebLinkView.tsx`) already exist, and for the pages worth pinning they mostly do
not work: Jira and GitHub refuse to be framed, so the tab becomes a card with an "open in browser"
button. Even when a page does frame, it is the whole site at the wrong size, logged in or not
depending on third-party cookies, with no way to act on it from the session.

A widget turns that around. Hangar fetches the *data* on the server, where the credentials are, and
the session draws a view of exactly the fields that matter. Because Hangar owns both ends it can
also act: log time, re-run a workflow, drop a ticket's description into the chat's message box.

## 2. The prompt is the source; the files are the build

There were two ways to go:

| | Claude generates the widget once | The prompt is stored and run every time |
| --- | --- | --- |
| Speed | instant | 10–15 s per refresh (measured, §6.2) |
| Cost | nothing at runtime | a model call per refresh |
| Output | the same layout every time | layout and fields drift between runs |
| Write actions | fixed code does exactly one thing | a model re-decides what "log 30 min" means |
| Auth | the script needs its own token | reuses the MCP connectors Claude already has |
| Judgment ("summarise the comments") | cannot | the point of it |

Both, in different places. **Authoring** is always Claude: a prompt goes in, a folder of files comes
out through the API (§9), and the prompt is saved with it so the widget can be regenerated or
amended. **At runtime** the view is always fixed code; the *data source* is either a fixed Node
script, or a Claude call when the data sits behind an MCP connector or needs judgment. The examples
in §12 use both: the in-progress list calls the Jira REST API with a key every 30 seconds; the time
tracker goes through the claude.ai Jira connector on demand.

## 3. Concepts

- **Widget type.** A named folder (`jira-ticket`) holding a manifest, a view and a data source. It
  takes **params** (`key`), declares which **placements** it supports, which **secrets** it needs
  and which **actions** it has.
- **Widget instance.** A type plus its param values plus a placement, open in one session:
  `jira-ticket{key=PROJ-123}` as a tab. Instances belong to the session; types to you, a project
  or a repo (§4).
- **Placement.** Where an instance is drawn, and how:

  | Placement | Where | Shows the view |
  | --- | --- | --- |
  | `tab` | the session's tab strip, like a shell or a PR | in the pane, as the active tab |
  | `tab-popover` | the session's tab strip, as a compact button (icon, title, badge) | in a popover anchored to the button; the active tab stays as it was |
  | `header` | the session's main header, next to the "i" (`SessionInfoPopover`, `SessionView.tsx`) | in a popover, like the session info |

  The two tab-strip placements are tabs in the layout (`PaneKind` gains `"widget"`, refs are
  `widget:<instanceId>`), so they move between groups and splits like every other tab. A
  `tab-popover` button is only never *activated*: clicking it opens the popover instead. A type
  lists the placements it supports, first one the default; an instance has exactly one, and can be
  switched from its context menu.

  The **badge** is a short text a type takes from its data (`⏱ 2h 15m`, `3`, `CI ✓`), shown after
  the icon in the two button-like placements. It is what makes a popover widget useful closed: the
  number is visible at a glance, and the popover is opened only to read more or to act.

## 4. Where widget types live

Three scopes, all listed in the **+** menu with a scope badge:

| Scope | Where | Who sees it |
| --- | --- | --- |
| **Personal** | listed in `%LocalAppData%\Hangar\widgets.json`; files in `%LocalAppData%\Hangar\widgets\personal\<name>\` | you, in every session on that node, in a project or not |
| **Project** | listed in the project's entry in `projects.json`; files in `%LocalAppData%\Hangar\widgets\<projectId>\<name>\` | you, in every session of that project, on that node |
| **Repo** | `.hangar/widgets/<name>/` at the git root of the session's folder | everyone who clones the repo |

Personal is for what follows *you* rather than the work: time logged today, your tickets in progress,
your open PRs. Project is for what belongs to one piece of work: its board, its pipeline, its
staging health check. Repo is project scope shared through git.

The list files record *that* a widget exists and its bookkeeping (`{ name, rev, updatedAt,
updatedBy }`). In `projects.json` that is a `Widgets` field on the project, init-only with an empty
default like `Repos`, so an older file goes on loading. The files themselves sit in the app-data
folder rather than inline in the JSON: a 20 KB HTML string inside `projects.json` is no good to the
session editing it or to a person diffing it. Like projects (`multi-node.md`, "Per-node data"),
personal and project widgets live on one node and run there.

**One name in several scopes:** the most specific personal one wins — **project, then personal,
then repo** — and the others are listed beneath it as shadowed. Project before personal because it
is narrower: a project can carry its own `jira-ticket` pointed at its own Jira site while every
other session keeps yours. Personal before repo because personal beats shared, the rule Claude
Code's own settings follow (`settings.local.json` over `settings.json`), and it lets you try a
change to a team widget before committing it.

**Repo widgets are code from someone else.** Opening one runs its data source on your machine, with
your Claude login, your connectors and your secrets. So a repo widget runs only once you have
approved it, and the approval is for its content: Hangar keeps a hash of the folder with the
approval, and a `git pull` that changes any file asks again, listing what changed. A repo widget
written by one of your own sessions through the API is approved as it is written — that session
could have run the same code directly.

## 5. A widget's folder

```
jira-ticket/
  widget.json        manifest: params, placements, secrets, source, actions, the authoring prompt
  view.html          the view: one self-contained document, no external resources
  fetch.mjs          data source when source.kind is "node" (absent for "claude" and "push")
  actions/
    comment.mjs      one file per action of kind "node"
```

```json
{
  "contract": 1,
  "name": "jira-ticket",
  "title": "{key}",
  "icon": "ticket",
  "params": {
    "key": { "type": "string", "pattern": "[A-Z][A-Z0-9]+-\\d+", "from": ["session", "branch"] }
  },
  "placements": ["tab", "tab-popover", "header"],
  "source": {
    "kind": "claude",
    "prompt": "Fetch Jira issue {key}. Return its summary, status, assignee, priority, description as Markdown, and the total time logged.",
    "tools": ["mcp__claude_ai_Jira__getJiraIssue"],
    "model": "claude-haiku-4-5-20251001",
    "schema": { "type": "object", "properties": { "summary": { "type": "string" } }, "required": ["summary"] },
    "refresh": "manual"
  },
  "badge": "status",
  "prompt": "Show a Jira ticket by key: summary, status, assignee, description."
}
```

`contract` is the version of this format the widget was written against (§9.1), so a later Hangar
can still read an older widget, or say exactly why it can't.

### 5.1 Params and the session's context

A param may be given when the instance is opened, or filled from the session it is open in. `from`
lists where to look, in order:

| `from` | Reads |
| --- | --- |
| `session` | the session's name, as Hangar shows it |
| `branch` | the session's branch (or its worktree's, `/api/self/worktree`) |
| `folder` | the session's folder |

With a `pattern`, the first match is taken: a session named `PROJ-123 login timeout` or on branch
`feature/PROJ-123-login` yields `PROJ-123`. A param filled this way stays **linked**: it is read
again on every fetch and every action, so renaming the session to the next ticket moves the widget
with it. A value typed in when opening the instance overrides the link for that instance.

A param with a `default` and no `from` is simply optional. A type whose params are all optional
opens with no questions asked, which is what a "time logged today" widget wants.

## 6. Data sources

### 6.1 Node

`fetch.mjs` gets `{ params, secrets }` as JSON on stdin and writes the data as JSON to stdout;
anything on stderr is shown in the view's error state and returned by the test call (§9.3). It runs
with the session's folder as its working directory (so it can read the repo, for example to find the
current workflow file), a 30-second timeout, and an environment **without** `HANGAR_HOOK_TOKEN`: a
widget script must not be able to act as the session through `/api/self/*`.

**Node is required, and it is the only runner.** One runner means a widget written on the PC runs
unchanged on the NAS and the Mac, and Claude writes one language well instead of three dialects of
shell. Hangar looks for `node` on PATH (overridable with `Widgets:Node`) and needs version 20 or
later, for built-in `fetch`. On a node without it, node-source widgets are listed greyed out with
the reason, and writing one through the API succeeds with a warning saying it cannot run there.

### 6.2 Claude

The prompt (params substituted) runs as a headless one-shot:

```
claude -p --model <model> --tools "" --allowedTools <tools…> --permission-mode default
       --output-format json --json-schema <schema> --settings '{"disableAllHooks":true}'
       --no-session-persistence          (the prompt on stdin)
```

with `HANGAR_SESSION_ID`, `HANGAR_HOOK_TOKEN` and `HANGAR_URL` removed from its environment, and
its working directory set to a scratch folder rather than the repo. Each of those is load-bearing:

- **No hooks, no Hangar variables.** Otherwise the nested `claude` reports its hooks as the session
  that opened the widget, and that session's state flips to idle and back on every refresh.
  (`--bare` would skip hooks too, but it accepts only API-key auth, and Hangar runs on the user's
  OAuth login.)
- **`--tools ""`, an allowlist and `--permission-mode default`.** The run can call the MCP tools the
  manifest names, and no built-in tool: no shell, no file writes. The mode is explicit so that a
  `defaultMode` in the user's settings (`acceptEdits`, `bypassPermissions`) cannot widen it; headless,
  a tool not allowed is denied, not asked (verified 2026-11-18: the call shows in
  `permission_denials`). An allow rule the user wrote for an MCP tool still applies — it is theirs.
  (`--setting-sources ""` would drop those too, but it drops the claude.ai connectors with them, and
  `dontAsk` mode left the allowlisted connector unusable.)
- **`--json-schema`.** The answer arrives as `structured_output`, already validated, so the view
  never parses prose.

Measured on 2026-11-10, against the claude.ai Jira connector (`getAccessibleAtlassianResources`):
the connector is reachable from `-p` with the OAuth login, and one call takes **~13 s** wall-clock
(about 10 s of model time, 4 turns). Cost is a few tens of cents at list price for a cold call,
mostly from writing the prompt cache. That rules out polling: a Claude source refreshes **on
demand**, on open when stale, and after an action — never on a short interval.

### 6.3 Push

A session can feed its own widget with no fetcher at all: `POST /api/self/widget/data` with the
instance id and a JSON payload. "Progress: 4/7 migrations" in the header while a long task runs
costs nothing per update. A type whose `source.kind` is `"push"` has only a view.

### 6.4 Refresh and the cache

`refresh` is `"manual"` or an interval: at least **30 s** for a Node source, at least **15 min**
for a Claude one. A timer runs only while some browser has the instance on screen (a closed popover
counts, so its badge stays current; a tab hidden behind another doesn't), so a forgotten widget
polls nothing.

The last good result of every instance is kept server-side with its fetch time, so a view opens
instantly on the previous data, shows its age ("fetched 4 min ago"), and refreshes in the background
when it is staler than its `refresh`. A failed refresh keeps the old data on screen with the error
beside it rather than blanking the view.

### 6.5 Secrets

A type lists the secrets it needs by name (`"secrets": ["JIRA_BASE_URL", "JIRA_EMAIL",
"JIRA_API_TOKEN"]`). The values belong to **you or a project**, not to the widget: every widget
that asks for `JIRA_API_TOKEN` gets the same one, so a second Jira widget asks for nothing new.
A name is looked up in the session's project first, then in your personal secrets — so one personal
Jira token serves everywhere, and a project on a different Jira site overrides it with its own.
Repo widgets read the same values: the repo says what it needs, each person supplies their own.

- **Entering one.** Opening an instance whose secrets aren't all set shows a form drawn by Hangar,
  outside the widget's frame, naming each missing secret and the widget that wants it. The value
  goes from that form to the server and nowhere else. The form saves to **personal** by default,
  with "only for project *X*" as the alternative when the session is in one; a personal widget's
  secrets are always personal, since it may open outside any project.
- **Storing them.** Per node, in `%LocalAppData%\Hangar\widget-secrets.json`, encrypted with DPAPI
  for the current user on Windows; on Linux and macOS, the same file at mode `0600`.
- **Who sees them.** The Node source only, on stdin. Never the view, the widget folder, the
  test call's output, the cache, or a Claude source (which needs none: its connectors are
  Claude's).
- **From a session.** The API reports which secrets are *missing*, never their values (§9.2).

## 7. The view

`view.html` runs in a sandboxed iframe on the same terms as the HTML preview (`PreviewTicketStore`):
`sandbox="allow-scripts"` with **no** `allow-same-origin`, so the document has an opaque origin, no
cookies and no bearer token. On top of that it is served with
`Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src
'unsafe-inline'; img-src data:` — **it can make no network request**. All network access
happens in the data source, on the server.

One way out remains, and no policy inside a frame closes it: the view can navigate its own frame
(`location = "https://…?" + data`), carrying what it holds in the URL. Hangar cannot stop that, so it
contains it: the bridge reports `pagehide` before the view's own code can interfere, and the page
then sends that frame nothing more, accepts nothing from it, and mounts the view afresh (three times
in ten seconds and it is stopped). What a navigation could carry is what the view was already given.
That is the reason the guide insists views build their DOM with `textContent`: the realistic way
a view comes to navigate is a ticket title or a commit message pasted into `innerHTML`.

It talks to Hangar only through `postMessage`, wrapped in a small `hangar` object Hangar injects:

| Call | Does |
| --- | --- |
| `hangar.onData(fn)` | `fn(data, { fetchedAt, error, params })` on open and after every refresh or push |
| `hangar.refresh()` | refetch now |
| `hangar.action(name, args)` | run a declared action (§8); resolves with its result |
| `hangar.openWidget(type, params, placement?)` | open another widget in this session — a list opening a ticket |
| `hangar.toChat(text)` | put text in the session's message box, without sending it |
| `hangar.openUrl(url)` | open a link in a new browser tab, on the user's click |
| `hangar.resize(height)` | ask for a popover height that fits the content |
| `hangar.theme` | the current theme's tokens as CSS variables, re-sent on change |

The theme tokens matter: a widget written on a light theme should not glare on a dark one, and the
guide (§9.1) tells Claude to colour only through them. Errors thrown in the view
(`window.onerror`, unhandled rejections, `console.error`) are forwarded through the same channel and
kept per instance, so the session that wrote the view can read them (§9.3) — it cannot see the
page, and this is how it finds out its view is broken.

## 8. Actions

An action is declared in the manifest — a Node script or a Claude prompt with its own tool allowlist
— and the view can only ask for it by name, with arguments the action's `params` validate. A view
cannot invent an action or pass it anything the manifest does not allow. An action's params use the
same `from` linking as the type's (§5.1), so "log time" can take the ticket from the session name at
the moment it runs.

An action marked `confirm` (every action that writes, by the guide's rule) shows a Hangar-drawn
confirmation outside the iframe: the action's name, its arguments, and the widget it came from. A
confirmation drawn by the view itself would prove nothing. After an action succeeds, the instance
refreshes.

## 9. The widget API

Everything Claude needs to write a widget comes from Hangar itself, over the same self-service API a
session already uses to rename itself or open a file (`docs/api.md`): `X-Session-Id` /
`X-Hook-Token`, the same trust boundary, nothing new to configure. Two `hgr-*` commands, shipped in
`claude-commands/` like the others, wrap it:

| Command | Does |
| --- | --- |
| `/hgr-widget` | Creates, changes, lists or deletes widget types from a description: "create a widget for …", "make the jira-time badge show minutes", "delete the ci widget" |
| `/hgr-open-tab` | Opens an instance: `hgr-open-tab jira-ticket key=PROJ-123`, or "open the Jira ticket for this branch" |

Both are thin. Neither carries the widget format: `/hgr-widget` starts by fetching the guide (§9.1),
so a command file installed months ago still writes widgets for the Hangar that is running now.

### 9.1 The guide: `GET /api/self/widgets/guide`

```json
{
  "contract": 1,
  "guide": "# Writing a Hangar widget\n…",
  "manifestSchema": { "$schema": "https://json-schema.org/draft/2020-12/schema", "…": "…" },
  "bridge": "…the hangar.* reference from §7…",
  "examples": [{ "name": "jira-in-progress", "files": { "widget.json": "…", "view.html": "…", "fetch.mjs": "…" } }],
  "environment": { "node": "24.22.1", "claude": "available", "scopes": ["personal", "project", "repo"], "defaultScope": "project", "project": "Hangar", "repoRoot": "C:\\Git\\…" }
}
```

- **`guide`** is the prose: the folder format, the placements, the rules — no network in the view,
  `confirm` on every write action, colours only from the theme, Node over Claude when the data is
  plain and a key is at hand, Claude when it sits behind a connector or needs judgment, test before
  you finish.
- **`manifestSchema`** is the JSON Schema the server validates `widget.json` against. It is the
  validator's own schema, not a copy written for documentation, so the guide cannot drift from what
  Hangar accepts.
- **`examples`** are complete, working widgets, one per source kind and placement. A model given a
  working example of the exact format gets it right far more often than one given only a schema.
- **`environment`** says what this session can actually do: whether Node is there, which scopes it
  may write (§9.4), which project and repo those are.

### 9.2 Types: list, read, write, delete

| Call | Does |
| --- | --- |
| `GET /api/self/widgets` | Types this session can open: scope, name, title, params, placements, `rev`, missing secrets, approval state, shadowed-by |
| `GET /api/self/widgets/{scope}/{name}` | One type: every file's content, and its `rev` |
| `PUT /api/self/widgets/{scope}/{name}` | Create, or replace every file: `{ "files": { "widget.json": "…", "view.html": "…" }, "rev": 3 }` |
| `PATCH /api/self/widgets/{scope}/{name}` | Change some files: the same body, where a `null` deletes a file |
| `DELETE /api/self/widgets/{scope}/{name}` | Remove the type; its open instances show "this widget was deleted" |

A write is validated before anything touches the disk, and the response says everything wrong at
once, each with the file and the path inside it:

```json
{ "ok": false,
  "errors": [
    { "file": "widget.json", "path": "/source/refresh", "message": "a claude source refreshes at most every 15 min; got \"30s\"" },
    { "file": "view.html", "line": 41, "message": "loads https://unpkg.com/…; a view has no network — inline it" }
  ],
  "warnings": [{ "file": "widget.json", "message": "secret JIRA_API_TOKEN is not set for this project yet; the user will be asked on first open" }] }
```

`rev` makes writes safe when two writers meet — another session, or you editing a file by hand: a
`PUT` or `PATCH` carrying a stale `rev` is refused with `409` and the current `rev`, and the caller
re-reads and merges rather than overwriting. A write with no `rev` creates, and fails if the type
already exists.

A successful write bumps `rev`, records which session made it, and **reloads every open instance**
of that type, on every device: the view is replaced and the data refetched. That is the loop the
user sees — they ask for "a coloured pill", and the tab beside the chat changes.

### 9.3 Trying it: test and log

| Call | Does |
| --- | --- |
| `POST /api/self/widgets/{scope}/{name}/test` | Runs the data source with `{ "params": {…} }`; returns `{ ok, data, stderr, durationMs, schemaErrors }` |
| `GET /api/self/widgets/instances/{id}/log` | What the view reported (§7): errors with their line, and the last data it was given |

Test runs the source exactly as an instance would, secrets included, without opening anything; its
response never echoes the secret values, even if a script prints one (known values are masked in
`stderr` and `data`). A missing secret fails the test with the names to ask the user for. Test does
not run actions: an action writes, so it runs only from an open view, through the Hangar
confirmation.

The guide tells Claude to finish every write this way: test the source on a real param, open an
instance with `/hgr-open-tab`, read its log, fix and repeat until both are clean. A widget is not
reported done while its own log shows an error.

### 9.4 What a session may write

- **Personal scope** — always, from any session on the node.
- **Project scope** — the project this session's folder falls under (`ProjectMembership`), and only
  that one.
- **Repo scope** — the git root of this session's folder. The files land in the working tree, as
  ordinary changes for the user to commit.

**Which scope, when the prompt doesn't say.** The guide's `defaultScope` is **project** when the
session is in one, otherwise **personal**. Repo is never a default: it is chosen only when asked
for ("for the team", "commit it to the repo"), because it puts files in the working tree. The guide
also tells Claude to pick personal on its own when the description is about the user rather than
the work ("*my* tickets", "time *I* logged today"), and to say which scope it chose when it reports
back, so a wrong guess is one "move it to personal" away. Moving a widget between scopes is a
`PUT` to the new scope and a `DELETE` of the old one; `/hgr-widget` does both on "move".

A session can't write another project's widgets or another node's: the API is the node's own, and
`/api/self/*` always acts for the calling session. That matches the rest of the self API.

### 9.5 From the + menu

**+ → Widget…** opens a dialog: pick a type (with its scope and any missing secrets), fill the
params that aren't linked, choose a placement, open. **New widget…** in the same dialog asks for a
description and a scope, then starts a child session (`hgr-run-session`) running `/hgr-widget
<description>` in this session's folder. There is one way to write a widget, and the menu is just a
shortcut to it: the child session is a normal one, so you can watch it, answer its questions and ask
for changes, and close it when you're done. **Edit…** on an instance does the same with "change
`<name>`: " in front of what you type.

## 10. Security, in one place

- The view has no origin, no token and makes no network request (§7). Data reaches it only through
  `postMessage`; a view that navigates itself away is cut off and remounted. `toChat` is honoured
  only straight after a click in the view, so a view cannot fill the message box on its own.
- A Node source runs without `HANGAR_HOOK_TOKEN`; a Claude source runs without any `HANGAR_*`
  variable, without hooks, with no built-in tools, in `default` permission mode, and with only the
  MCP tools its manifest names (plus any the user's own settings allow).
- A forced refresh this soon after the last one (60 s for a Claude source, 5 s for Node) gets that
  one's data: a view calling `refresh()` in a loop cannot turn into a model call after another.
- Secrets are entered in a Hangar form, stored encrypted per node and handed only to Node sources.
  No API reads one back; a value a script prints is masked out of the test call, the data and its
  errors — best effort, since the session writing the script could encode one past the mask, and is
  trusted to the same degree as it is to run code here at all (§6.5).
- Actions are declared, their arguments validated, and writes confirmed by Hangar outside the frame.
- Repo widgets run only once approved, and again after any change to their files (§4).
- Writing widgets needs nothing a session doesn't already have. A session can already run any code
  on this machine, so letting it write a widget that runs code later grants nothing new — and the
  write is recorded against the session that made it.

## 11. Phases

1. **Runtime and API.** Personal- and project-scope types; Node and Claude sources; refresh, cache and secrets;
   the sandboxed view and its bridge; the `tab`, `tab-popover` and `header` placements; the guide,
   list/read/write/delete, test and log endpoints; `/hgr-widget` and `/hgr-open-tab`. Done when a
   session, given only the first and third prompts in §12, writes working widgets through the API.
2. **Actions, and the menu.** Declared actions with the Hangar confirmation; `hangar.openWidget`;
   **+ → Widget…** and **New widget…**. Done with the second prompt in §12, end to end.
3. **The team.** Repo-scope types with the content-hash approval; shadowing across all three
   scopes.
4. **The rest.** Push sources.

## 12. Worked examples

Three prompts this design has to satisfy, and what a session should write for each.

**"Create a widget to get my Jira tickets in progress, show them as a tab that opens a popup,
refreshing every 30 s, using a Jira API key."**

- Name: `jira-in-progress`, **personal** scope ("*my* tickets"). Placement `tab-popover`; badge is
  the count.
- Node source: `fetch.mjs` calls `GET {JIRA_BASE_URL}/rest/api/3/search/jql` with JQL
  `assignee = currentUser() AND statusCategory = "In Progress" ORDER BY updated DESC`, basic auth from
  `JIRA_EMAIL` + `JIRA_API_TOKEN`. Refresh `30s`.
- Secrets `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`: asked for on first open and saved as
  personal, then shared by every Jira widget in every session.
- View: a list of key, summary and status; clicking a row calls
  `hangar.openWidget("jira-ticket", { key })` when that type exists, and `hangar.openUrl` otherwise.

**"Create a widget for time tracking to Jira (worklog). Show today's time by default, allow tracking
time against a Jira key I give or the one in the session name, using the connected Jira MCP."**

- Name: `jira-time`, **personal** scope (time *I* logged). Placement `header`; badge is today's
  total (`⏱ 2h 15m`). No required params.
- Claude source over the connector: worklogs by the current user dated today, summed and listed per
  ticket. Tools `searchJiraIssuesUsingJql`, `getJiraIssue`. Refresh `manual`, which still runs on
  open when stale and after every logged entry.
- Action `logTime` (Claude, `confirm: true`, tool `addWorklogToJiraIssue`): params `key`
  (`pattern` for a Jira key, `from: ["session"]`, overridable in the form), `minutes`, `comment`.
- View: today's entries, and a small form — key prefilled from the session name, minutes, comment,
  **Log**.

**"Create a widget with a tab showing a Jira task's content."**

- Name: `jira-ticket`, as in §5; project scope by default (personal if the session is in no
  project). Placement `tab`; `key` linked to the session name, then the branch.
- Claude source with `getJiraIssue`; the view renders the description's Markdown and offers
  **To chat**, which puts the summary and description in the message box (`hangar.toChat`).

## 13. Open questions

- **Cost visibility.** Should a Claude-source widget show what its last refresh cost? It is
  subscription usage for most users, not dollars, but a widget refreshed carelessly is a real drain.
- **Other nodes.** A project widget exists on one node. Copying it to another (or promoting it to a
  repo widget so every node gets it through git) is manual in phase 1. Is that enough?
- **A crowded header.** Ten tickets open as header chips is too many. A cap, or overflow into the
  toolbar's "more" menu (`ToolbarMore.tsx`)?
