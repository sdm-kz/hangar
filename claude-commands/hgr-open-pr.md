---
description: Open a GitHub pull request as a tab in THIS Hangar session's tab bar, via the self-open-pr API (POST /api/self/open-pr)
argument-hint: [PR URL | number | owner/name number — omit to have Claude pick the PR this conversation is about]
allowed-tools: Bash, PowerShell
---

# Open a pull request in this session's tab bar

Put a pull request in front of whoever is watching this Hangar session: it gets a review tab in
the session's own tab bar, exactly as picking it from the tab bar's PR picker would.

Requested PR: **$ARGUMENTS**

## Step 1 — Decide which PR

If `$ARGUMENTS` is non-empty, that is the PR. It can be:

- a URL — `https://github.com/owner/name/pull/42` (anything after the number is fine)
- a number — `42`, meaning the session folder's own repo (its `origin` remote)
- a repo and a number — `owner/name 42` or `owner/name#42`

If `$ARGUMENTS` is empty, pick the PR this conversation is actually about, usually the one you just
created (`gh pr create` printed its URL) or the one you were asked to review. If you can't name one
with confidence, say so and stop. Don't guess.

## Step 2 — Check you're in a Hangar session

Same credentials as `/hgr-open-file` and `/hgr-rename-session`:

```bash
echo "url=[$HANGAR_URL] id=[$HANGAR_SESSION_ID] token=[${HANGAR_HOOK_TOKEN:+present}]"
```

- `HANGAR_SESSION_ID` empty → this session wasn't launched by Hangar. Stop and say so.
- `HANGAR_URL` empty but the id is set → fall back to `http://127.0.0.1:5099` and mention it.

## Step 3 — Call the API

Send exactly one of `{"url": …}` or `{"number": …}`, with `"repo": "owner/name"` added for a PR
outside the session folder's own repo.

```bash
curl -s -w '\n%{http_code}\n' -X POST "${HANGAR_URL:-http://127.0.0.1:5099}/api/self/open-pr" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{"url":"https://github.com/owner/name/pull/42"}
JSON
```

PowerShell equivalent:

```powershell
$url = if ($env:HANGAR_URL) { $env:HANGAR_URL } else { 'http://127.0.0.1:5099' }
Invoke-RestMethod "$url/api/self/open-pr" -Method Post `
  -Headers @{ 'X-Session-Id' = $env:HANGAR_SESSION_ID; 'X-Hook-Token' = $env:HANGAR_HOOK_TOKEN } `
  -ContentType 'application/json' -Body (@{ repo = 'owner/name'; number = 42 } | ConvertTo-Json -Compress)
```

The server looks the PR up through `gh` before opening it, so the call can take a few seconds.

Read the status code. The body alone is not the result:

| Code | Meaning | What to do |
| --- | --- | --- |
| `200` | Opened. Body: `{"repo":…,"number":…,"title":…,"key":…}` | Report it |
| `400` | Body `error` says why: no number, bad repo/URL, folder not on GitHub and no `repo`, or gh's answer (no such PR, not signed in) | Fix what the error names; retry once at most |
| `401` | Headers missing or wrong | Re-check step 2; do not retry blindly |
| `404` | No live session with that id | The session is gone from the app. Say so and don't retry |
| connection refused | Hangar isn't running | Say so; nothing to do from here |

## Step 4 — Know what the user sees

The tab reaches every device the session is open on. A newly opened PR arrives as the active tab,
so a browser showing the session switches to the review. A PR that already had a tab keeps it, with
its title refreshed, and nobody's view moves. Eight reviews is the cap, and past it the oldest tab
closes.

## Step 5 — Report

One line: which PR now has a tab (`owner/name#N title`). Mention the fallback URL or a non-200 code
if either applied.
