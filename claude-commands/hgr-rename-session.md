---
description: Rename THIS Hangar session from inside it, via the self-rename API (POST /api/self/name)
argument-hint: [new name — omit to have Claude pick one from the work so far]
allowed-tools: Bash, PowerShell
---

# Rename this session

Rename the Hangar session you are running in, so its name in the sidebar says what this
conversation is actually about.

Requested name: **$ARGUMENTS**

## Step 1 — Decide the name

If `$ARGUMENTS` is non-empty, that **is** the name. Use it verbatim — do not "improve", translate,
re-case, or re-punctuate it.

If `$ARGUMENTS` is empty, derive one from the work so far: the task, ticket key, or bug you have
actually been doing in this session — not the folder name, not a generic label like "coding" or
"session". Keep it under ~60 characters (the server hard-caps at 100), no leading/trailing spaces,
no newlines. Prefer what the user would recognise at a glance in a list:

- `AB-123 fix invoice rounding` — ticket key + what it is
- `wireguard for db access`
- `fix flaky auth middleware tests`

Spaces and non-ASCII (Cyrillic, dashes, emoji) are all fine. If you genuinely can't tell what this
session is about yet, say so and stop — do not invent a name.

## Step 2 — Check you're in a Hangar session

The credentials arrive as environment variables that only exist in a session Hangar launched:

| Variable | Meaning |
| --- | --- |
| `HANGAR_URL` | Base URL of the app, e.g. `http://127.0.0.1:5099` |
| `HANGAR_SESSION_ID` | This session's id — also the session that gets renamed |
| `HANGAR_HOOK_TOKEN` | Local secret that authorizes the call |

```bash
echo "url=[$HANGAR_URL] id=[$HANGAR_SESSION_ID] token=[${HANGAR_HOOK_TOKEN:+present}]"
```

- `HANGAR_SESSION_ID` empty → this session wasn't launched by Hangar. Stop and say so;
  there is nothing to rename.
- `HANGAR_URL` empty but the id is set → an older session launched before the app added that
  variable. Fall back to `http://127.0.0.1:5099` and mention you did.

## Step 3 — Call the API

One request. `$NAME` must be JSON-escaped — escape `\` and `"` inside it, nothing else:

```bash
curl -s -w '\n%{http_code}\n' -X POST "${HANGAR_URL:-http://127.0.0.1:5099}/api/self/name" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{"name":"<THE NAME>"}
JSON
```

PowerShell equivalent, if you're already working there:

```powershell
$url = if ($env:HANGAR_URL) { $env:HANGAR_URL } else { 'http://127.0.0.1:5099' }
Invoke-RestMethod "$url/api/self/name" -Method Post `
  -Headers @{ 'X-Session-Id' = $env:HANGAR_SESSION_ID; 'X-Hook-Token' = $env:HANGAR_HOOK_TOKEN } `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes((@{ name = '<THE NAME>' } | ConvertTo-Json -Compress)))
```

Read the status code — the body alone is not the result:

| Code | Meaning | What to do |
| --- | --- | --- |
| `200` | Renamed. Body echoes the applied name: `{"id":"…","name":"…"}` | Report that name — it's the sanitized one the sidebar shows |
| `400` | Name was empty after sanitizing (all whitespace/control chars) | Pick a real name and retry once |
| `401` | Headers missing or wrong | Re-check step 2; do not retry blindly |
| `404` | No live session with that id | The session is gone from the app — say so, don't retry |
| connection refused | Hangar isn't running | Say so; nothing to do from here |

The endpoint only ever renames **this** session — the id comes from your own environment, so you
cannot point it at someone else's session, and there is no need to look one up.

## Step 4 — Expect a `/rename` in your own terminal

On success the server also injects `/rename <name>` into this session's terminal, so Claude Code's
own conversation title follows the sidebar. Since you are that terminal, the command lands in your
input queue and runs once the current turn ends. That is expected:

- Do **not** call the API again when you see it.
- Do **not** type `/rename` yourself as well — that would be a second, redundant rename.

## Step 5 — Report

One line: the applied name, and that the session now shows it in the Hangar sidebar. Mention the
fallback URL or any non-200 code if either applied. Nothing else in this session changes — no files,
no git state.
