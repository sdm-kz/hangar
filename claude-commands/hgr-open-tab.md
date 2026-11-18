---
description: Open a Hangar widget in THIS session — as a tab, a tab-strip popup or a header chip — via the self-widget API (POST /api/self/widget)
argument-hint: <widget name> [param=value …] [as tab | as popup | in header] — or a description like "the Jira ticket for this branch"
allowed-tools: Bash, PowerShell
---

# Open a widget in this session

Open an instance of a widget type in this Hangar session, exactly as the tab strip's **+ → Widget…**
does. It reaches every device the session is open on.

Request: **$ARGUMENTS**

## Step 1 — Check you're in a Hangar session

```bash
echo "url=[$HANGAR_URL] id=[$HANGAR_SESSION_ID] token=[${HANGAR_HOOK_TOKEN:+present}]"
```

- `HANGAR_SESSION_ID` empty → this session wasn't launched by Hangar. Stop and say so.
- `HANGAR_URL` empty but the id is set → use `http://127.0.0.1:5099` and mention it.

## Step 2 — Find the widget

```bash
curl -s "${HANGAR_URL:-http://127.0.0.1:5099}/api/self/widgets" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" -H "X-Hook-Token: $HANGAR_HOOK_TOKEN"
```

`types` lists what this session can open: each with its `name`, `params` (and which are read from
the session — `from`), `placements`, and `missingSecrets`. Match the request to one:

- a name given (`jira-ticket key=PROJ-12`) → that type, those params;
- a description ("the Jira ticket for this branch") → the type that fits; a param the type reads
  from the session (`from: ["session","branch"]`) is best **left out**, so it stays linked;
- none fits → say which exist, and that `/hgr-widget` can write a new one. Stop.

Placement: "as a tab" → `tab`, "as a popup"/"button" → `tab-popover`, "in the header" → `header`;
nothing said → leave it out (the type's default).

## Step 3 — Open it

```bash
curl -s -w '\n%{http_code}\n' -X POST "${HANGAR_URL:-http://127.0.0.1:5099}/api/self/widget" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary '{"type":"jira-ticket","params":{"key":"PROJ-12"},"placement":"tab"}'
```

PowerShell equivalent:

```powershell
$url = if ($env:HANGAR_URL) { $env:HANGAR_URL } else { 'http://127.0.0.1:5099' }
Invoke-RestMethod "$url/api/self/widget" -Method Post `
  -Headers @{ 'X-Session-Id' = $env:HANGAR_SESSION_ID; 'X-Hook-Token' = $env:HANGAR_HOOK_TOKEN } `
  -ContentType 'application/json' -Body (@{ type = 'jira-ticket'; params = @{ key = 'PROJ-12' } } | ConvertTo-Json -Compress)
```

| Code | Meaning | What to do |
| --- | --- | --- |
| `200` | Opened: `{ id, type, scope, placement, params, linked, title, missingSecrets }` | Report it |
| `400` | Bad params or placement; `error` says which (a required param not given and not found in the session, a value not matching its pattern…) | Fix what it names; retry once |
| `404` | No such widget here (the error lists the ones there are), or the session is gone | Say so |
| `401` | Headers missing or wrong | Re-check step 1 |

Opening the same widget with the same params in the same place again goes back to the one open.

## Step 4 — Report

One line: what opened and where (`jira-ticket PROJ-12 as a tab`). Say which params are `linked` to
the session (they follow its name or branch), and if `missingSecrets` is not empty, that Hangar will
ask for them when the widget first shows.
