---
description: Send the user a notification (push to their phone + every open Hangar tab) from THIS Hangar session via POST /api/self/notify — now, or chained after a background command so it fires when that ends
argument-hint: [message — or "when <what> finishes"; omit to notify about what just finished]
allowed-tools: Bash, PowerShell
---

# Notify the user from this session

Put a message in front of the user wherever they are: a Web Push on every device subscribed to Hangar
(their phone), and an OS notification in every open Hangar tab. It is titled with this session's name;
tapping it opens the session.

Request: **$ARGUMENTS**

Use it when the user asked to be told — "notify me when the benchmark is done", "ping me if the
deploy fails" — or invoked this command. Don't notify on your own initiative for ordinary turns: the
sidebar already marks a finished turn, and a phone that buzzes for every one gets muted.

## Step 1 — Now, or when something ends?

- **Now**: the thing the user is waiting on has already happened (you just finished it, or you just
  read its result). Go to step 3 with the message.
- **When a command finishes**: the work runs in the background (a benchmark, a long build, a test
  run). Chain the notification **onto that command itself** — step 4 — rather than promising to send
  it later: you may not get a turn when it ends, and a chained call fires regardless.

Write the message the way the user would want to read it on a lock screen: the outcome and the one
number that matters, not "task complete".

- title `Benchmark done`, message `Accuracy 97.8% (was 97.6%), 14 min — no drop.`
- title `Deploy failed`, message `build.ps1 exited 1: tsc found 3 errors in web/src/App.tsx.`

`title` is optional and short (≤120 chars, one line); `message` is required (≤1000 chars).

## Step 2 — Check you're in a Hangar session

| Variable | Meaning |
| --- | --- |
| `HANGAR_URL` | Base URL of the app, e.g. `http://127.0.0.1:5099` |
| `HANGAR_SESSION_ID` | This session's id — also the session the notification is about |
| `HANGAR_HOOK_TOKEN` | Secret that authorizes the call |

```bash
echo "url=[$HANGAR_URL] id=[$HANGAR_SESSION_ID] token=[${HANGAR_HOOK_TOKEN:+present}]"
```

- `HANGAR_SESSION_ID` empty → not a session Hangar launched. Say so and stop.
- `HANGAR_URL` empty but the id is set → fall back to `http://127.0.0.1:5099` and mention it.

## Step 3 — Notify now

JSON-escape the text (`\` and `"`; newlines as `\n`):

```bash
curl -s -w '\n%{http_code}\n' -X POST "${HANGAR_URL:-http://127.0.0.1:5099}/api/self/notify" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{"title":"Benchmark done","message":"Accuracy 97.8% (was 97.6%), 14 min — no drop."}
JSON
```

PowerShell:

```powershell
$url = if ($env:HANGAR_URL) { $env:HANGAR_URL } else { 'http://127.0.0.1:5099' }
Invoke-RestMethod "$url/api/self/notify" -Method Post `
  -Headers @{ 'X-Session-Id' = $env:HANGAR_SESSION_ID; 'X-Hook-Token' = $env:HANGAR_HOOK_TOKEN } `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes((@{ title = 'Benchmark done'; message = 'Accuracy 97.8%' } | ConvertTo-Json -Compress)))
```

## Step 4 — Notify when a background command ends

Append the call to the command you run in the background, so the shell sends it the moment the work
ends and reports how it ended. The environment variables are inherited by the background shell.

Nobody is watching when it fires, so the JSON must be valid whatever the command printed. Build it
with a JSON encoder, never by pasting output into a hand-written string (a quote in a log line turns
it into a `400` nobody sees), and send it on stdin, which keeps non-ASCII intact on Windows too. Log
the status so a failure is at least on record.

```bash
./bench.sh > bench.log 2>&1; code=$?
python -c 'import json,sys; print(json.dumps({"title": "Benchmark finished", "message": sys.argv[1]}))' \
  "bench.sh exited $code. Last line: $(tail -n 1 bench.log)" |
curl -s -o /dev/null -w 'notify: %{http_code}\n' -X POST "${HANGAR_URL:-http://127.0.0.1:5099}/api/self/notify" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" --data-binary @- >> bench.log
exit $code
```

(`python3` where `python` isn't one; with neither, keep the message to fixed text and `$code`.)

PowerShell, where `ConvertTo-Json` does the escaping:

```powershell
.\bench.ps1 *> bench.log; $code = $LASTEXITCODE
$url = if ($env:HANGAR_URL) { $env:HANGAR_URL } else { 'http://127.0.0.1:5099' }
$body = @{ title = 'Benchmark finished'; message = "bench.ps1 exited $code. Last line: $(Get-Content bench.log -Tail 1)" } | ConvertTo-Json -Compress
try {
  Invoke-RestMethod "$url/api/self/notify" -Method Post -ContentType 'application/json; charset=utf-8' `
    -Headers @{ 'X-Session-Id' = $env:HANGAR_SESSION_ID; 'X-Hook-Token' = $env:HANGAR_HOOK_TOKEN } `
    -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
} catch { "notify failed: $_" | Add-Content bench.log }
exit $code
```

Run the whole block as the background command (one call with `run_in_background`). Keep the
command's own exit code (`exit $code`) so the shell still reports success or failure honestly. Put
the line that actually says how it went into the message (a summary, a score) when the command
prints one; otherwise the exit code and the log's path.

Tell the user it's armed: one line saying what will notify them and when.

## Responses

| Code | Meaning | What to do |
| --- | --- | --- |
| `200` | Sent. `{"id":"…","devices":N}` — N devices got the push | If `devices` is `0`, say only an open Hangar tab will show it (no phone is subscribed) |
| `400` | Message empty, or the body isn't valid JSON | Fix the body and retry once |
| `401` | Headers missing or wrong | Re-check step 2; don't retry blindly |
| `404` | No live session with that id | Say so; don't retry |
| `429` | More than six from this session (or twenty from all sessions) in a minute | Don't loop; wait or fold them into one |
| connection refused | Hangar isn't running | Say so |

## Step 5 — Report

One line: what was sent (or armed), and how many devices got it.
