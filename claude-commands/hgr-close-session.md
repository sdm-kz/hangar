---
description: Close Hangar sessions nested under THIS one (or this one itself) by id, name, or a description like "all review sessions" — via GET /api/self/children + POST /api/self/close
argument-hint: <it | self | id | name | "all child sessions" | "all review sessions" | text filter> [--remove] [--force]
allowed-tools: Bash, PowerShell
---

# Close sessions

Close Hangar sessions that sit **under this session** in the sessions list — the children it launched
with `/hgr-run-session`, the review session from `/hgr-run-session-review`, forks, and anything nested
under those — or this session itself.

Request: **$ARGUMENTS**

Closing is the sidebar's close: the process stops and the row **stays in the list, reopenable**.
`--remove` also takes the rows out of the list. A closed session takes everything under it with it.

## Step 1 — Check you're in a Hangar session

```bash
echo "url=[$HANGAR_URL] id=[$HANGAR_SESSION_ID] token=[${HANGAR_HOOK_TOKEN:+present}]"
```

- `HANGAR_SESSION_ID` empty → this session wasn't launched by Hangar, so it has nothing under it to
  close from here. Stop and say so; the user can close sessions from the Hangar UI.
- `HANGAR_URL` empty but the id is set → fall back to `http://127.0.0.1:5099` and mention it.

## Step 2 — List what's under this session

```bash
curl -s -w '\n%{http_code}\n' "${HANGAR_URL:-http://127.0.0.1:5099}/api/self/children" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN"
```

**Server too old:** a `404` with `{"error":"no such endpoint"}`, or a `200` whose body is an HTML page
rather than JSON (builds before that 404 existed), means this Hangar predates `/api/self/close`. Stop:
say the Hangar server needs updating (a full deploy) before this command works, and that the
sessions can be closed from the sidebar meanwhile. Don't treat the HTML as an empty list.

Each child has `id`, `name`, `parentId`, `depth` (1 = direct child), `state` (`Running`, `Exited`,
`Failed`, or `Restorable` = already closed), `busy` (mid-turn), `folder`. This list is the **only**
set you may pick from (besides this session itself) — the server refuses anything else anyway.

## Step 3 — Resolve the request to ids

Map `$ARGUMENTS` by meaning:

| Request | Targets |
| --- | --- |
| `it`, `that session`, `the one that just reported` | The session whose `<cross-session-message from="NAME">` you most recently received — the child whose `name` is exactly `NAME`. No such message in this conversation → ask which one. |
| `self`, `this session`, `me` | `"self"` — see Step 5 before doing it. |
| a 32-hex id | That id, if it is in the list. |
| a name | The child whose name matches exactly; failing that, case-insensitively. |
| `all child sessions`, `all children`, `everything under me` | Every **direct** child (`depth` 1) — their own children go with them. |
| `all review sessions`, `nested review sessions`, other text | Children whose name contains the text (`review` → names ending in `-review` or containing `review`), case-insensitive, at any depth. |

Then drop children of a target already chosen — the server closes a subtree with its root, so listing
both is redundant. Unless `--remove` was given, leave out any target already `Restorable`, and say
it was already closed.

**When to go ahead and when to ask first:**

- One exact match (`it`, an id, an exact name) → close it, no question.
- A filter or "all …" → state the list you resolved (`closing 3: a-review, b-review, c-review`) and
  then close. Ask first only if the match is surprising — it would take a session that is busy, or
  one whose name doesn't obviously fit what the user said.
- Nothing matches → say so, show the children that do exist (name + state), and stop. Never widen a
  filter on your own to find something to close.

## Step 4 — Close

```bash
curl -s -w '\n%{http_code}\n' -X POST "${HANGAR_URL:-http://127.0.0.1:5099}/api/self/close" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{"ids":["<id>","<id>"],"remove":false,"force":false}
JSON
```

- `"remove": true` only when the user said `--remove` (or "remove", "delete them from the list").
- `"force": true` only when the user said `--force` (or plainly asked to close a session that is still
  working). Never set it on your own to get past a `busy` skip.

The answer:

| Field | Meaning |
| --- | --- |
| `closed` | Stopped; rows stay in the list as closed sessions |
| `removed` | Stopped (if running) and taken out of the list |
| `skipped` | Each with a `reason`: `busy` (mid-turn — rerun with `--force` if the user wants), `already closed`, `not this session or one under it` |
| `self` | `true` when this session is closing itself — see Step 5 |

`400` = no id given (a bug in Step 3), `401` = headers missing or wrong (recheck Step 1, don't retry
blindly), `404` = this session is no longer known to Hangar, connection refused = Hangar isn't running.

## Step 5 — Closing this session itself

`self` closes **this** session — the one you are running in — together with everything under it.
The server answers first and stops this process half a second later, so:

- Do it only when the user (or the brief you were launched with) asked for it explicitly.
- Do everything else first: finish writing files, send any `SendMessage` you owe the parent session,
  then report — the close request is the **very last** tool call. Nothing after it will run.
- In the final reply, say the session is closing and that it can be reopened from the Hangar sidebar.

## Step 6 — Report

One or two lines: what was closed (names), what was removed, what was skipped and why. For a `busy`
skip, mention `--force`. Nothing else changes — no files, no git state.

## Rules

- **Only sessions under this one.** Never try to close a sibling, the parent, or a session found any
  other way (`ListAgents`, `sessions.json`). The endpoint refuses them, and going around it with the
  API key or the UI's `DELETE` is not this command's job — tell the user to close those from the UI.
- A review session reused across rounds (`/hgr-run-session-review` Step 3a) loses its context when
  closed. Closing it is the user's call; don't do it unprompted after a review round.
- Closing stops a real `claude` process. A closed row can be reopened from the sidebar, but whatever
  the session was doing mid-turn is gone — that is why `busy` sessions are skipped by default.
