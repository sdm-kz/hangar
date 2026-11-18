---
description: Create, change, list or delete Hangar widgets — small live views (a tab, a tab-strip popup, a header chip) — from a description, via the widget API (/api/self/widgets)
argument-hint: [what the widget should show, e.g. "my Jira tickets in progress as a popup, every 30s" | "change jira-time: show minutes" | list | delete <name>]
allowed-tools: Bash, PowerShell, Read, Write
---

# Write a Hangar widget

A widget is a small live view this Hangar session shows — a tab in its tab strip, a button in the
tab strip that opens a popup, or a chip in its header — fed by a Node script or a headless Claude
call. You write it through Hangar's API; Hangar checks it, runs it, and reloads every open copy.

Request: **$ARGUMENTS**

## Step 1 — Check you're in a Hangar session

```bash
echo "url=[$HANGAR_URL] id=[$HANGAR_SESSION_ID] token=[${HANGAR_HOOK_TOKEN:+present}]"
```

- `HANGAR_SESSION_ID` empty → this session wasn't launched by Hangar. Stop and say so.
- `HANGAR_URL` empty but the id is set → use `http://127.0.0.1:5099` and mention it.

## Step 2 — Read the guide. Always, first

Hangar serves the format, the rules, the JSON Schema it checks against and complete working
examples. **Read it before writing anything**, even if you think you know the format: it is the
contract of the Hangar that is running now, and it changes between versions.

```bash
H=(-H "X-Session-Id: $HANGAR_SESSION_ID" -H "X-Hook-Token: $HANGAR_HOOK_TOKEN")
U="${HANGAR_URL:-http://127.0.0.1:5099}"
T="$(mktemp -d)"   # a scratch folder outside the repo, for the guide and the files you write
curl -s "${H[@]}" "$U/api/self/widgets/guide" > "$T/guide.json"
node -e 'const g=require(process.argv[1]);console.log(g.guide);console.log("\n--- environment ---\n"+JSON.stringify(g.environment,null,2))' "$T/guide.json"
```

Then read `manifestSchema` and the `examples` (each a full widget, by file) in the same file. Keep
everything you write for the widget in `$T`, never in the session's folder.

## Step 3 — Work out what is asked

- **list** → `GET $U/api/self/widgets` and report each type: name, scope, placements, what it shows.
- **delete <name>** → find its scope in the list, `DELETE $U/api/self/widgets/{scope}/{name}`, report.
- **change <name>: …** (or a request that plainly names an existing widget) → `GET` it, change what
  is asked, write it back with the `rev` you read (PATCH for a few files, PUT for all).
- **move <name> to personal/project** → write its files to the new scope, then delete the old one.
- **anything else** is a new widget. Choose:
  - a **name**: short, lowercase, dashes (`jira-in-progress`, `jira-time`, `ci-runs`);
  - a **scope**: `environment.defaultScope`, except **personal** when the widget is about the user
    rather than the work ("*my* tickets", "time *I* logged"). Never write to another scope than the
    two the guide lists;
  - a **source**: node when the data is a plain HTTP API, CLI or the repo and a key is at hand;
    claude when it is behind an MCP connector this session has (look at your own tool names —
    `mcp__claude_ai_Jira__…`) or needs judgment;
  - **placements** and **refresh** as asked ("as a popup" → `tab-popover`; "in the header" →
    `header`; "as a tab" → `tab`; "every 30 seconds" → `"30s"`, within the guide's limits).

If the request leaves something that matters genuinely open — which Jira site, which board — ask
once. Otherwise pick sensibly and say what you picked.

## Step 4 — Write it

Write the files into a scratch folder, then send them as one JSON body (the guide shows how). Start
from the nearest example. Put the user's request, in their words, in `widget.json`'s `prompt`.

```bash
curl -s -w '\n%{http_code}\n' -X PUT "$U/api/self/widgets/<scope>/<name>" "${H[@]}" \
  -H "Content-Type: application/json" --data-binary @"$T/body.json"
```

| Code | Meaning | What to do |
| --- | --- | --- |
| `200` | Written: `{ ok, rev, warnings, missingSecrets }` | Read the warnings; go on |
| `422` | `{ errors, warnings }`, every problem at once, each with file and path/line | Fix them all; write again |
| `409` | It exists (no `rev` sent), or changed since your `rev` | `GET` it, merge, resend with its `rev` — or, for a new widget, pick another name |
| `400`/`404` | Scope or name wrong; body says which | Fix and retry once |
| `401` | Headers missing or wrong | Re-check step 1 |

## Step 5 — Test the source

```bash
curl -s -X POST "$U/api/self/widgets/<scope>/<name>/test" "${H[@]}" -H "Content-Type: application/json" \
  --data-binary '{"params":{}}'
```

`ok: false` comes with `error` and `stderr`: fix and test again. `missingSecrets` is not a failure
of yours — the user enters them in Hangar when the widget first opens; tell them. A claude source
takes 10–20 seconds.

## Step 6 — Open it and read its log

```bash
curl -s -X POST "$U/api/self/widget" "${H[@]}" -H "Content-Type: application/json" \
  --data-binary '{"type":"<name>","params":{},"placement":"<placement>"}'
# → { "id": "w…", … }
sleep 5
curl -s "$U/api/self/widgets/instances/<id>/log" "${H[@]}"
```

The log lists what the view threw or logged once a browser showed it, and when it was last handed
data. Errors there are bugs in your view: fix and write again (the open widget reloads by itself).
An empty log with a `note` means no browser has the session open — say the view is untested rather
than claiming it works.

Remove `$T` when done.

## Step 7 — Report

A few lines: the widget's name and scope, what it shows and where, how to open it again
(`/hgr-open-tab <name> param=value`), and any secrets the user will be asked for. Mention anything
you picked that they didn't specify.
