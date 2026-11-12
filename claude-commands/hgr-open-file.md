---
description: Open a file (or several) as tabs in THIS Hangar session's tab bar, via the self-open API (POST /api/self/open)
argument-hint: [paths — omit to have Claude pick the files this conversation is about]
allowed-tools: Bash, PowerShell
---

# Open files in this session's tab bar

Put a file in front of whoever is watching this Hangar session: it gets a tab in the session's
own tab bar, next to Terminal/Split/Files, exactly as clicking it in the Files panel would.

Requested paths: **$ARGUMENTS**

## Step 1 — Decide which files

If `$ARGUMENTS` is non-empty, those are the files. Paths are relative to the session's working
directory (an absolute path inside it works too). Take them as given — don't substitute "better"
files.

If `$ARGUMENTS` is empty, pick the files this conversation is actually about: the ones you just
changed, or the ones you are asking the user to look at. A handful, not a directory listing — every
one of them becomes a tab the user has to close. If nothing obvious qualifies, say so and stop.

Only files under the session's **own working directory** can be opened. A file elsewhere on disk is
rejected, and so is a folder.

## Step 2 — Check you're in a Hangar session

Same credentials as `/hgr-rename-session`, injected into every session Hangar launches:

| Variable | Meaning |
| --- | --- |
| `HANGAR_URL` | Base URL of the app, e.g. `http://127.0.0.1:5099` |
| `HANGAR_SESSION_ID` | This session's id — also the session whose tabs open |
| `HANGAR_HOOK_TOKEN` | Local secret that authorizes the call |

```bash
echo "url=[$HANGAR_URL] id=[$HANGAR_SESSION_ID] token=[${HANGAR_HOOK_TOKEN:+present}]"
```

- `HANGAR_SESSION_ID` empty → this session wasn't launched by Hangar. Stop and say so; there
  is no tab bar to open anything in.
- `HANGAR_URL` empty but the id is set → an older session launched before that variable existed.
  Fall back to `http://127.0.0.1:5099` and mention you did.

## Step 3 — Call the API

One request for all of them. `paths` is a JSON array; `path` (a single string) also works. Escape
`\` and `"` inside a path, nothing else — use forward slashes and life is easier.

```bash
curl -s -w '\n%{http_code}\n' -X POST "${HANGAR_URL:-http://127.0.0.1:5099}/api/self/open" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{"paths":["server/Program.cs","web/src/App.tsx"]}
JSON
```

PowerShell equivalent, if you're already working there:

```powershell
$url = if ($env:HANGAR_URL) { $env:HANGAR_URL } else { 'http://127.0.0.1:5099' }
Invoke-RestMethod "$url/api/self/open" -Method Post `
  -Headers @{ 'X-Session-Id' = $env:HANGAR_SESSION_ID; 'X-Hook-Token' = $env:HANGAR_HOOK_TOKEN } `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes((@{ paths = @('server/Program.cs') } | ConvertTo-Json -Compress)))
```

Optional field: `"pin": false` puts the file in the single transient "preview" slot instead — the
one a single click in the tree reuses, so the next preview replaces it rather than adding a tab.
The default (`true`) gives each file a tab of its own. The last file opened becomes the active one.

Read the status code — the body alone is not the result:

| Code | Meaning | What to do |
| --- | --- | --- |
| `200` | Opened. Body: `{"opened":[…],"missing":[…],"active":"…"}` | Report `opened`; mention `missing` if it isn't empty |
| `400` | No path given, or **none** of them resolved to a file in the session's folder | Check the paths against the working dir; retry once |
| `401` | Headers missing or wrong | Re-check step 2; do not retry blindly |
| `404` | No live session with that id | The session is gone from the app — say so, don't retry |
| connection refused | Hangar isn't running | Say so; nothing to do from here |

A `200` can still carry a non-empty `missing`: paths that escaped the working directory, named a
folder, or aren't there. Those simply weren't opened.

## Step 4 — Know what the user sees

The tab appears in the session's tab bar on **every** device the session is open on — the tabs are
saved server-side, not per browser. What it does **not** do is take over the pane: a browser sitting
on the Terminal view stays there, with the new tab waiting one click away, and a browser already
showing Files/Split/a file switches to the file. That is deliberate — a session shouldn't yank the
view out from under someone mid-read.

So don't tell the user "I've opened X on your screen". Tell them the tab is in the bar.

## Step 5 — Report

One line: which files now have tabs, and anything in `missing`. Mention the fallback URL or a
non-200 code if either applied. Nothing else changes — no files are read, written, or touched.
