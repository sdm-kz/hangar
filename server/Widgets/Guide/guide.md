# Writing a Hangar widget

A widget is a small live view a Hangar session shows: a tab in its tab strip, a button in the tab
strip that opens a popover, or a chip in the session's header that opens one. It is a folder of a
few files that you write through Hangar's API; Hangar checks them, runs them, and reloads every open
copy the moment you write.

This guide, `manifestSchema` and `examples` in the same response are all you need. Read the examples:
they are complete, working widgets, and starting from the nearest one is the quickest way to a
correct one.

## The loop

1. **Pick a scope** (see "Scopes"). The response's `environment.defaultScope` is the default.
2. **Write** the files with `PUT /api/self/widgets/{scope}/{name}`. Fix every error the response
   lists and write again; read the warnings.
3. **Test** the source: `POST /api/self/widgets/{scope}/{name}/test` with real params. It runs the
   source exactly as an instance would and returns the data, or the error and stderr.
4. **Open** an instance: `POST /api/self/widget`. It answers with the instance id.
5. **Read its log**: `GET /api/self/widgets/instances/{id}/log` lists what the view threw or logged
   once a browser showed it, and whether it was handed data. Fix and repeat until it is clean.
6. **Report** which scope you chose, what the widget shows and how to open it
   (`/hgr-open-tab <name> param=value`). Say if the user must enter secrets.

A widget is not done while its test fails or its log shows an error. If no browser has the session
open, the log stays empty: say so rather than claiming the view works.

## The folder

| File | What it is |
| --- | --- |
| `widget.json` | The manifest: name, params, placements, source, badge, secrets. Checked against `manifestSchema`. |
| `view.html` | The view: one self-contained HTML document. Required. |
| `fetch.mjs` | A node source's script (another name with `source.run`). |

Up to 20 files, 256 KB each; lowercase names, at most one folder deep, ending `.json`, `.html`,
`.mjs`, `.js`, `.md`, `.css` or `.txt`. Keep `widget.json`'s `prompt` up to date with what the
widget does: it is what someone (or you, later) regenerates it from.

## Sources: where the data comes from

Pick **node** when the data is plain and reachable with an HTTP API, a CLI or the repo, and a key is
at hand. Pick **claude** when it sits behind an MCP connector the user already has (Jira, Google
Drive, Todoist…) or needs judgment (summarise, classify). A claude source takes 10–15 seconds and a
model call per refresh; a node source takes milliseconds.

### node

```json
"source": { "kind": "node", "run": "fetch.mjs", "refresh": "30s" }
```

The script runs with `node` (20 or later, so `fetch` is built in), in the **session's folder**, with
a 30-second timeout (`timeoutSeconds` up to 180). It reads one JSON object on stdin and prints the
data as JSON on stdout:

```js
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const { params, secrets, context } = JSON.parse(raw);
// context: { session, branch, folder, today }
process.stdout.write(JSON.stringify({ /* the data */ }));
```

A non-zero exit is an error; the first line of stderr is shown. Never print a secret — Hangar masks
any it sees, but a masked value is a broken widget. No `HANGAR_*` variable is set for it.

### claude

```json
"source": {
  "kind": "claude",
  "prompt": "Fetch Jira issue {key} … Return …",
  "tools": ["mcp__claude_ai_Jira__getJiraIssue"],
  "model": "claude-haiku-4-5-20251001",
  "schema": { "type": "object", "properties": { … }, "required": [ … ] },
  "refresh": "manual"
}
```

Run as `claude -p` with no built-in tools at all (no shell, no files), only the MCP tools in `tools`
by their full names, and `schema` as the shape of the answer — which arrives as the data. Name every
tool the run needs, including lookups such as `getAccessibleAtlassianResources` for a cloud id: a
tool not listed is denied, and the run reports which one it tried. Use the tool names you can see in
your own session. `{param}`, `{session}`, `{branch}`, `{folder}` and `{today}` are filled into the
prompt. Keep the schema flat and small; ask for exactly the fields the view shows.

### refresh

`"manual"` (the default), or an interval: `"30s"`, `"5m"`, `"1h"`. At least `30s` for node and
`15m` for claude. A manual widget fetches when first opened and when the user (or the view) asks.
Intervals run only while the instance is on screen.

## Params

```json
"params": {
  "key": { "type": "string", "pattern": "[A-Z][A-Z0-9]+-\\d+", "from": ["session", "branch"] },
  "count": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }
}
```

A param is given when the instance is opened, or read from the session: `from` lists where to look
— `session` (its name), `branch`, `folder` — and with a `pattern` the first match is taken, so a
session named `PROJ-123 login timeout` yields `PROJ-123`. A value found that way stays **linked**:
it is read again on every fetch, so renaming the session moves the widget along. A typed value is
cut down to its first match the same way. A param with a `default` (or `"required": false`) is
optional; a widget whose params are all optional opens with no questions.

## Placements

```json
"placements": ["tab-popover", "tab"]
```

The first is the default; an instance may be opened in any listed one.

| | Where | The view shows |
| --- | --- | --- |
| `tab` | the session's tab strip | in the pane, like a file or a PR. Room for detail. |
| `tab-popover` | the tab strip, as a compact button: icon, title, badge | in a popover under the button |
| `header` | the session's main header, beside the session's info button | in a popover under the chip |

`badge` is a dot path into the data (`"count"`, `"today.total"`); its value is shown after the icon of
a `tab-popover` or `header` instance. An array shows its length. It is what makes a popover widget
useful closed: the number is visible at a glance. A popover is 360 px wide unless `popover.width`
says otherwise, and as tall as its content (up to 70% of the window).

`title` labels the tab or button, with `{param}` filled in. `icon` is one of: `activity`,
`alarm-clock`, `bell`, `blocks`, `book-open`, `bot`, `briefcase`, `bug`, `calendar`, `chart-bar`,
`chart-line`, `circle-check`, `clipboard-list`, `clock`, `cloud`, `code`, `cpu`, `database`,
`file-text`, `flag`, `flame`, `gauge`, `git-branch`, `git-commit-horizontal`, `git-pull-request`,
`globe`, `hammer`, `heart`, `inbox`, `layers`, `list`, `list-checks`, `list-todo`, `mail`,
`message-square`, `package`, `play`, `rocket`, `server`, `shield`, `sparkles`, `square-kanban`,
`star`, `target`, `terminal`, `ticket`, `timer`, `trending-up`, `users`, `wrench`, `zap`. Anything
else shows a generic icon.

## The view

`view.html` runs in a sandboxed frame:

- **No network.** Its content-security policy allows inline script and style, `data:` images and
  nothing else: no `fetch`, no external script, font, stylesheet or image. Inline everything. All
  data comes from the source, through `hangar.onData`.
- **Never change `location`.** A view that navigates its frame is cut off by Hangar and reloaded;
  it shows in the log as a warning.
- **`hangar.toChat` works from a click.** Called on its own, it is refused.
- **No origin.** No cookies, no storage that lasts, no access to Hangar's page.
- **Links do not navigate.** Call `hangar.openUrl(url)` from a click instead.

Hangar puts this in front of the view, so it is always there:

| Call | Does |
| --- | --- |
| `hangar.onData(fn)` | `fn(data, { fetchedAt, error, params, loading })` now if there is data, and on every change. `data` is the last good data (kept while a refresh fails, with `error` beside it); `loading` is true while a fetch is running. |
| `hangar.refresh()` | Fetch again now. Returns a promise. |
| `hangar.toChat(text)` | Put text in the session's message box, without sending it. |
| `hangar.markdown(text)` | Markdown rendered as an element, ready for `node.replaceChildren(…)`: headings, lists, code, quotes, tables, links (they open in a browser tab). Safe for text someone else wrote — use it for any description, comment or body that is Markdown, rather than showing the raw text. |
| `hangar.openUrl(url)` | Open an http(s) link in a new browser tab. |
| `hangar.resize(height)` | Ask for a popover height (popovers follow the content on their own). |
| `hangar.theme` | `{ dark, "--background": …, … }`, the current theme. |

**Colours.** Use only Hangar's theme variables, which are set on the document and follow the user's
light or dark theme: `--background`, `--foreground`, `--card`, `--popover`, `--primary`,
`--primary-foreground`, `--secondary`, `--muted`, `--muted-foreground`, `--accent`, `--border`,
`--destructive`. The body is transparent over Hangar's own background and uses Hangar's font at 13 px.

**Build the DOM safely.** Create elements and set `textContent` (see the `h()` helper in the
examples); never paste data into `innerHTML`. Ticket titles and commit messages are text someone
else wrote.

**Hangar draws a status line above every view**: when the data was fetched, whether a fetch is
running, the last error, and a refresh button. Don't repeat any of them in the view; spend the space
on the data.

**Handle every state**: no data yet (`loading`), an error (`meta.error`, possibly with old data still
there — keep showing the data), and an empty result. Errors thrown in the view are reported to its
log; check it.

## Secrets

A node source that needs a token lists its names: `"secrets": ["JIRA_BASE_URL", "JIRA_EMAIL",
"JIRA_API_TOKEN"]` (uppercase, digits, `_`). The values are the user's, entered in Hangar the first
time an instance opens; the script gets them as `secrets` on stdin. They are shared by every widget
that names them, so reuse the same names for the same service. **Never** ask the user to paste a
secret into the chat, and never write one into any file. `GET /api/self/widgets` reports which are
missing; tell the user they will be asked for them.

A claude source gets no secrets: its MCP connectors bring their own sign-in.

## Scopes

| Scope | Lives | Seen in |
| --- | --- | --- |
| `personal` | the user's app-data folder | every session on this machine |
| `project` | the app-data folder, under the session's project | the sessions of that project |

Default to `environment.defaultScope` (project when the session is in one, personal otherwise). Pick
**personal** when the widget is about the user rather than the work: "*my* tickets", "time *I*
logged today". When a project and a personal widget share a name, the project's is the one that
opens. To move a widget, write it to the new scope and delete the old one.

## The API

Every call carries the session's own credentials:

```sh
-H "X-Session-Id: $HANGAR_SESSION_ID" -H "X-Hook-Token: $HANGAR_HOOK_TOKEN"
```

| Call | Does |
| --- | --- |
| `GET $HANGAR_URL/api/self/widgets/guide` | This guide, the schema and the examples. |
| `GET $HANGAR_URL/api/self/widgets` | Types this session can open, with scope, params, placements, `rev`, missing secrets, problems. |
| `GET $HANGAR_URL/api/self/widgets/{scope}/{name}` | One type's files and its `rev`. |
| `PUT $HANGAR_URL/api/self/widgets/{scope}/{name}` | Create, or replace every file: `{ "files": { "widget.json": "…", … }, "rev": 3 }`. Without `rev` it creates and fails if it exists. |
| `PATCH $HANGAR_URL/api/self/widgets/{scope}/{name}` | Change some files: `{ "files": { "view.html": "…", "old.mjs": null }, "rev": 3 }`. |
| `DELETE $HANGAR_URL/api/self/widgets/{scope}/{name}` | Remove the type. |
| `POST $HANGAR_URL/api/self/widgets/{scope}/{name}/test` | `{ "params": { … } }` → `{ ok, data, error, stderr, durationMs, missingSecrets, params }`. |
| `POST $HANGAR_URL/api/self/widget` | Open an instance: `{ "type": "jira-ticket", "params": { "key": "PROJ-1" }, "placement": "tab" }` → `{ id, … }`. |
| `GET $HANGAR_URL/api/self/widgets/instances/{id}/log` | What the view reported: `{ entries: [{ level, message, line }], deliveredAt, rev }`. |

Write file contents as JSON strings. The simplest way from a shell is to write the files to a scratch
folder and build the body with a tool that escapes them, for example:

```sh
node -e 'const fs=require("fs");const d=process.argv[1];const files={};for(const f of fs.readdirSync(d))files[f]=fs.readFileSync(d+"/"+f,"utf8");process.stdout.write(JSON.stringify({files}))' ./my-widget \
  | curl -s -X PUT "$HANGAR_URL/api/self/widgets/personal/my-widget" \
      -H "X-Session-Id: $HANGAR_SESSION_ID" -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
      -H "Content-Type: application/json" --data-binary @-
```

A write answers `{ ok, rev, errors, warnings }`. An error names the file, a JSON Pointer `path` into
`widget.json` or a `line` in the view, and what is wrong — all of them at once. `409` means the
`rev` you sent is not the current one: read the type again, merge, and send the new `rev`.
