# Multiple server nodes: one UI over several machines

**Goal.** Hangar runs on more than one machine — the workstation, a laptop, the NAS, a Linux box —
and whichever one you open in the browser shows **all of them**: every node's projects, folders and
sessions in one sidebar, every session's terminal, files, shells and PRs one click away, and a new
session launched **on any node** from the same dialog. No second login, no second tab, no second URL
to remember.

**Non-goal (for now).** Moving a running conversation from one machine to another, projects whose
folders span machines, copy/paste of files between nodes, automatic discovery. Each is a later phase
(§9) and none of them is needed for the flow above. Also not a goal: a cluster. There is no leader,
no scheduler placing work, no replication — a node is a full Hangar that also knows its peers.

---

## 1. Shape: every node is whole, the one you opened is the lens

```
 Browser ── one origin, one login ──►  Node A  (the one you opened: "home")
                                         │  /api/*, /hub/*            → A itself, as today
                                         │  /n/{B}/api/*, /n/{B}/hub/* → proxied to B with A's peer token
                                         │  /n/{C}/…                  → proxied to C
                                         ├──────────────►  Node B  (full Hangar, unchanged API)
                                         └──────────────►  Node C
```

Every node runs the same `Hangar.exe`, owns its own sessions, stores and pty hosts exactly as
today, and is usable on its own. Pairing gives a node a list of peers and a credential for each. The
node the browser is on **proxies** a peer's whole API and its sockets under `/n/{nodeId}/…`, so the
SPA reaches any session on any node through the one origin it was loaded from.

Why a proxy through the home node rather than the browser talking to each node directly:

| | Browser → each node directly | Browser → home node → peer (chosen) |
| --- | --- | --- |
| Logins | one per node, tokens per origin | one |
| CORS / mixed content | needed on every node; https home + http peer is blocked | none — one origin |
| Reachability | every node must be reachable *from the phone* | only the home node; peers only from it |
| Exposure | every node's port faces the browser's network | one node faces it; peers can bind to the LAN/Tailscale only |
| Cost | — | home node relays terminal bytes (trivial on a LAN) |

The phone case decides it: you expose one Hangar (reverse proxy, Tailscale) and the rest stay
behind it. And because every node can proxy, **any** node can be the one you open — there is no
designated hub to lose.

The alternative of a central controller with thin agents on the other machines is rejected: it would
fork the product into two programs, and a machine would stop being usable on its own.

---

## 2. Node identity

Each node gets a stable identity in `node.json` in the data folder (`AppDataFolder.Root`:
`%LocalAppData%\Hangar`, `~/.local/share/Hangar`, …), written with the same `StateFile` helper:

```json
{ "id": "8f3c…", "name": "WORKSTATION", "color": "blue", "url": "https://nas.lan:5099" }
```

- `id` — minted once (GUID), never changes. Everything that names a node holds this.
- `name` — defaults to the machine name, editable. Shown on the node heading and in pickers.
- `color` — same palette as projects, so the heading and session marks are tellable at a glance.
- `url` — optional: the address **peers** reach this node at. Mutual pairing sends it to the peer;
  left empty, the peer uses the address the pairing request came from plus this node's port. The
  browser's own address is no use here — it is often `localhost`.

The data folder is shared by every instance on a machine, so two instances on one machine share an
identity unless one runs with `HANGAR_TEST_ROOT` (§10) — and pairing refuses a peer whose id is the
node's own.

`GET /api/node` returns `{ id, name, color, version, os, capabilities[] }`. `capabilities` is how a
newer home SPA talks to an older peer without guessing (same spirit as `projects()` filling in
`groups ?? []` today): `"node-v1"`, `"templates"`, `"schedules"`, `"github"`, `"ssh-files"`, …

---

## 3. Pairing and the peer credential

**Add node** (Settings → Nodes): enter the peer's URL and its password, once.

1. A calls `POST {B}/api/nodes/pair` with B's password and A's `{ id, name, color, url?, port }`.
2. B verifies the password, mints a **peer token** for A, stores it **hashed** in `peers-in.json`
   (who it was issued to, when, last used), and returns `{ token, node: { id, name, … } }`.
3. A stores B in `nodes.json`: `{ id, name, url, token, color, fingerprint?, enabled }`.
4. **Mutual by default:** the same handshake carries a token minted by A for B, so B lists A too —
   which is what makes "open any node and see all of them" true without pairing twice. A checkbox
   turns it off for a node that should be a peer of others but not see them (the NAS, say).
   B confirms the way back works before it stores A: it calls `GET {A}/api/node` with that token
   and expects A's id. A's address is `node.json`'s `url`, or — when that is empty — the address the
   pairing request came from with A's port. If B cannot reach A, pairing still succeeds one-way and
   says so; A then drops the token it minted for B, since nobody holds it.

The password is used for the handshake and discarded. The peer token is the long-lived credential.

**Neither side pairs without a password.** A node with no password set (`AuthDisabled`, the
localhost-dev mode) refuses `/api/nodes/pair`, refuses to add peers, and refuses `/n/*`: otherwise
anyone who could reach it would be handed every peer it holds a token for.

**Peer tokens are not browser tokens.** They live in their own store, never expire on the browser
tokens' 30-day TTL, and a request that authenticated with one is marked as such — which is what the
proxy's hop guard and the management endpoints below check.

**What a peer token grants.** Everything the browser token grants on `/api/*` and `/hub/*` — which
is shell on that machine as that user. That is the same trust as the password itself, so it is
stated plainly in the dialog. Not granted: `/n/*` (no second hop — §4), the node management
endpoints (`/api/nodes/*` and renaming the node), except `POST /api/nodes/unpair` — the caller
dropping its own token when it forgets this node. (There is no "change password" endpoint to deny:
the password is only ever set through `Auth:Password`. Rotating it does not revoke peer tokens.)

**Revocation.** Settings → Nodes lists both directions: *peers this node reaches* (forget = delete the
outbound token, and tell the peer to drop it too) and *nodes allowed in* (revoke = delete the
inbound hash, effective on the next request).

**Transport.** LAN HTTP is what the app does today, and a peer token on plain HTTP is no worse than
the browser's bearer token on plain HTTP. For anything else, `https://` peer URLs are supported:

- a certificate that validates against the OS trust store (Let's Encrypt behind a reverse proxy) is
  accepted as any HTTPS client would, and **not pinned** — pinning it would break on every renewal;
- one that does not (a self-signed cert on the NAS) is **trusted on first use** by its SHA-256
  fingerprint — the same pattern as `ssh-known-hosts.json` (`KnownHostStore`): shown at pairing,
  remembered with the peer, a changed one refused with a warning until re-trusted deliberately.
- The way back (B → A, mutual pairing) has no human to ask; B pins what A presents during the
  password-authenticated pairing call, and that is its first use. The cost, stated plainly: someone
  able to intercept B → A at that moment gets the token A minted for B. Until it is bound, that
  token opens nothing but `GET /api/node`; once bound, it is a shell on A. A later hardening: A
  sends its own certificate's fingerprint in the (authenticated) pairing request and B pins exactly
  that.

**Revocation is immediate, open connections included.** Revoking an inbound token cuts every
request in flight on it (a relayed terminal would otherwise outlive it for hours), and forgetting,
disabling or re-trusting a peer cuts what this node is relaying to it.

On Windows the outbound tokens in `nodes.json` are protected with DPAPI (current user — the daemon
runs as the user, also as a service, so this holds); elsewhere the file gets owner-only permissions,
like the instance file.

---

## 4. The proxy: `/n/{nodeId}/…`

Implemented with **YARP's `IHttpForwarder`** (`Yarp.ReverseProxy`), which forwards HTTP and
WebSocket upgrades and streams bodies (uploads, downloads, file previews) without buffering.

`/n/{nodeId}/{**rest}` → `{peer.url}/{rest}`, with these transforms:

- strip the browser's `Authorization` header and `access_token` query parameter; set
  `Authorization: Bearer <peer token>` (the peer's `TokenAuthMiddleware` already accepts the header on
  WebSocket upgrades from a server client — only browsers are limited to the query string);
- add `X-Hangar-Via: <home node id>`; the peer **refuses to proxy** any request that carries it,
  or that authenticated with a peer token — one hop, no loops, no chains through a node (the peer
  token is what actually stops it; the header is the belt to its braces);
- only `/api/*` and `/hub/*` are forwarded, and never `/api/self/*`, `/api/hooks`, `/api/nodes/*`,
  `/api/auth/*`, `/api/external/*`: a session's self-service calls go to its **own** node via
  `HANGAR_URL` exactly as now, and are never routed through someone else's;
- unknown or disabled `nodeId` → 404; peer unreachable → 502 with `{ error: "node offline" }`;
- a **401 from the peer becomes a 502** (`node unauthorized`): the SPA treats any 401 as "your login
  is gone" and signs out, and a peer that revoked us must not sign the browser out of the home node;
- no request size limit on the proxy route (the peer enforces its own); a generous idle timeout,
  since a terminal socket can sit silent for hours.

A route-local auth check runs before forwarding, so `/n/*` requires the browser token of the home
node — the peer token is never exposed to the browser.

`/api/preview/*` (the ticketed HTML preview) needs one exception: the sandboxed frame cannot present
the home node's token, so `GET /n/{id}/api/preview/*` passes the home node's auth like
`/api/preview/*` does, and is forwarded with the peer token. The ticket — minted on the peer, carried
in the path — stays the credential.

Everything in the SPA that builds a URL rather than calling `request()` — `serverFileUrl`,
`sessionFileUrl`, `remoteFileUrl`, `previewFrameUrl`, the socket helpers — takes the node base too
(phase 3), and the build check covers them as well as `api.`.

A side effect worth stating: restarting the home node (an update) drops every terminal open through
it, remote ones included. The peers' sessions are untouched; the sockets reconnect.

---

## 5. The live picture: a server-side mesh, not N browser sockets

The home node runs a **`NodeMesh`** background service (fifth beside `SessionHub`, `PushNotifier`,
`UpdateService`, `ScheduleService`). For each enabled peer it holds one connection to the peer's
`/hub/events`, keeps the latest snapshot, and tracks
`online | offline | unauthorized | incompatible | certificate-changed` with a backoff reconnect.

**Tick.** Connected as the tray (`?client=tray`), remote busy dots would lag up to five seconds;
connected as a browser, the peer would rebuild its snapshot every second all day — exactly the cost
`SessionHub`'s `IndicatorTickInterval` exists to avoid. So the mesh connects as `?client=peer`: slow
by default, and it sends `fast` / `slow` text frames on the socket as browsers come and go on the
home node. (The hub's read loop ignores client data today; it learns those two words.)

`/hub/events` on the home node then carries, alongside today's fields:

```json
{
  "node": { "id": "8f3c…", "name": "WORKSTATION" },
  "nodes": [
    { "id": "b21e…", "name": "NAS", "color": "teal", "status": "online", "version": "…",
      "snapshot": { /* the peer's own /hub/events message, verbatim */ } }
  ]
}
```

The peer's snapshot is passed through **whole and unparsed** rather than picked apart into
`sessions` / `busy` / `waiting`: today's snapshot has a dozen fields (`compacting`, `failed`,
`drafts`, `activity`, `shells`, `shellsRev`, `projectsRev`, `update`, …), each new one would
otherwise need plumbing twice, and an older home build would silently drop a newer peer's fields.
The peer's keep-alive re-sends are dropped (same bytes as the last one), so an idle peer does not
make the home node re-broadcast.

Why aggregate in the server rather than open one socket per node from the browser:

- **Push notifications.** A Web Push subscription is bound to one VAPID key, so a browser cannot
  subscribe to every node. The home node already sees remote sessions go *waiting* through the mesh,
  so its `PushNotifier` fires for them too, and the notification deep-links to `?node=<node>&session=<id>`.
  A phone subscribed on both A and B would otherwise get B's "waiting" twice (once from B, once
  from A via the mesh): every node tags its notifications `<nodeId>:<sessionId>`, so the second
  replaces the first (`sw.js` already collapses on `tag`), and the payload carries `nodeId`.
- **The tray** reads the home node's `/hub/events` and gets the other machines for free (a submenu per
  node), with no change to how it connects.
- **Search, sessions-progress menu, the orphan bar** all read one snapshot, as today.
- A peer that goes away is one status flip, not a browser socket error to handle in five places.

Peers do not mesh further: B's snapshot as seen by A contains only B's own sessions.

**As built (phase 4).**
- `Nodes/NodeMesh.cs` holds one link per enabled peer, keyed by its address, pinned certificate and token, so a
  re-pair or a re-trust reconnects it. Before each connect it probes `GET /api/node` (`NodePairing.ProbeAsync`):
  that is where the status words and the version come from, since a failed socket says nothing about why.
  Backoff 1 s → 20 s; 15 s of silence is a dead socket.
- A snapshot is kept as a `JsonElement` and passed on verbatim. Keep-alives (same bytes) are dropped, so they
  don't cause a re-broadcast. A snapshot carrying `nodes`/`node` of its own has them stripped, so an older
  peer can't add a hop.
- `SessionHub` keeps two pictures: this node's own, sent to anything that came in on a peer token (the mesh,
  or a browser through `/n/…`), and the whole one with `node` + `nodes[]`, sent to browsers and the tray.
  `?client=peer` is slow like the tray until it sends `fast`. The mesh says `fast` while a browser is
  connected here.
- `PushNotifier` reads the same transitions out of each peer's snapshot, seeded per peer when it comes online.
  Tags are `kind-<node>:<session>` for every alert, this node's own too. A relayed alert's payload carries
  `node`, and `sw.js` opens `?node=…&session=…` with it.
- The tray lists each peer as a submenu of its running sessions, grouped by folder. It doesn't group by
  project: a peer's projects aren't on the stream. An unreachable peer gets a line saying why.

---

## 6. The SPA: every session belongs to a node

This is the bulk of the work, and it is mostly mechanical.

**Identity.** `SessionInfo` gains `nodeId` (filled client-side from the snapshot it came in). Every
map, set and React key that is keyed by session id becomes keyed by `nodeId:id` (`sessionKey()`),
because two machines can in principle mint the same id and the UI must never confuse them. URL state:
`?session=<id>` gains `&node=<nodeId>`; a link without `node` means the home node, so existing bookmarks
keep working.

**The client.** `api.ts`'s `request(path)` takes a base: `""` for the home node, `/n/{nodeId}` for a
peer. A `NodeContext` provides it, and `useApi()` returns the client bound to the node in context.
`SessionView` (and `ShellView`, the file viewer, PR views, remote-files tab) sit inside a
`<NodeProvider node={session.nodeId}>`, so the dozens of calls inside them change from
`api.x(...)` to `const api = useApi(); api.x(...)` and need no node argument. The socket helpers
(`sessionsStreamUrl`, `TerminalPane`'s `socketPath`, shells) prefix the same base. Cross-node things
— the sidebar, search, new-session dialog — take the node explicitly.

**As built (phase 3).**
- `createApi(base)` / `apiFor(node)` in `lib/api.ts`; `NodeProvider`, `useApi()`, `sessionKey()`,
  `useSessionKey()` in `lib/node.tsx`. A session of this node keeps its bare id as its key, so
  everything stored before nodes still matches.
- The per-session stores (`sessionUi`, the repo cache) are keyed by session key and find the node
  from it; `postponed`, `prReview` and `upload` take the client.
- App follows a peer's own `/hub/events` through `/n/{id}` while one of its sessions is open
  (`lib/nodeStream.ts`), and acts on it — rename, reopen, fork, stop — through that node's client.
  Phase 4's mesh replaces that socket.
- A server file opened from a peer's session opens on that peer, and the standalone preview tab is
  offered for this node's files only.
- The app's file clipboard remembers the node a copy came from; pasting on another node is refused
  until cross-node copy (phase 6).
- "Reopen with options" is hidden for a peer's session until the dialog can launch there (phase 5).
- `web/scripts/check-node-scope.mjs` runs in `npm run build` and fails the build when a file outside
  its short list of this-node-only surfaces imports `api`, `apiFor`, the token or the URL helpers
  (under any alias, as a namespace, dynamically), or builds a `fetch`/socket to "/…" by hand.
- A peer's answers are data on this node's origin, so the client and the proxy hold them there:
  - every path a peer's client builds is checked to stay under `/n/{id}` after the browser resolves
    it — a peer's id with a `../` in it would otherwise reach this node's own API with its token;
  - `?node=` is taken only when it is a node id;
  - proxied responses get a script-less sandbox and no Referer, and anything that isn't plainly media,
    text or a PDF is a download: their URLs carry this node's token in the query, which a page there
    could read from its own address. Only the ticketed preview (no token in its URL) keeps scripts;
  - a browser shows no PDF in a sandbox, so a peer's PDF is fetched and shown from a blob;
  - a saved link tab must still be http(s) when it is restored — the session's UI bag is the peer's
    to write.
- A socket (`/hub/*`, and a peer's through `/n/…/hub/*`) is taken only from this node's own page
  (`Auth/SocketOrigin.cs`): its token rides in the URL, so a page that came by one could otherwise open
  shells from anywhere. No `Origin` (tray, mesh, scripts) passes. Behind a reverse proxy, `X-Forwarded-Host`
  counts as this node's host. A peer doesn't check a socket relayed to it: the relaying node did. The Vite dev
  proxy presents the backend's origin, so nothing on this machine is let through for being local.

**As built (phase 4), SPA.**
- `lib/nodeStream.ts` is now `usePeers()`, fed from `nodes` on this node's stream. The phase-3 per-peer socket
  is gone. A peer that stops being online keeps its last snapshot, so its open session survives a blip.
  Anything that counts or alerts reads `liveSnap()`, which is null while the peer is away.
- App works the finished ticks, the in-page alerts, the favicon, the sessions-progress menu and search out
  over every machine's sessions, keyed by `sessionKey`. A peer that has only just come online doesn't alert
  for what it already had going.
- The sidebar draws a heading per machine once there are peers. With none, it looks as it did before.
- A peer's tree is the same `SessionSidebar`, embedded inside the peer's `NodeProvider`. Its collapse, order
  and fork state are stored under keys suffixed with the node. Its keyboard-tree keys carry the node id, so
  the outer list routes ←/→/Enter back to it.
- A peer's rows offer what works there today: stop, remove, reopen, rename, fork, pin, projects and groups.
  Clone, schedule and "show in Files" are left out until phase 5.
- Still this node's only: the Recent tab, "New project" on the toolbar, and schedules.

**The sidebar.** One heading per node above the projects, coloured, with a status dot and the
machine's session count; collapsible like a project. The home node is first and marked as the one
you are on. An offline node keeps its heading, greyed, with *last seen* — its sessions are not
"gone", the link is. Inside a node heading everything is exactly today's tree: that node's
projects, virtual folders, folder groups and sessions, read from that node's stores. A setting
flattens the node level away when only one node exists, so a single-machine install looks the
same as now.

**Per-node data.** Projects, templates, schedules, pins, recents, linked folders, UI bags, push
subscriptions — all stay per node, in that node's files, fetched through that node's base. The SPA
already loads them per concern (`lib/projects.ts`, `lib/templates.ts`, …); each loader becomes
"for node X" and the sidebar asks for each node's set.

---

## 7. Launching on any node

The **New session** dialog gets a **Node** picker at the top:

- defaults to the node of whatever you started from — the **+** on a node's or project's heading, a
  template, a fork — and to the home node from the toolbar;
- the folder picker, recents and project folder chips re-query the **picked** node (paths are that
  machine's: `C:\Git\…` on Windows, `/srv/…` on the NAS), and are cleared when the node changes;
- **Templates** tab lists each node's templates under its heading. A template carries no node of its
  own — it belongs to the node it is stored on, and launches there;
- create posts to `/n/{node}/api/sessions`; the new row arrives through the mesh snapshot.

**Fork** and **child sessions** stay on the parent's node — the conversation's transcript lives in
that machine's `~/.claude/projects`. **Schedules** run on the node that stores them (its clock, its
`claude` login); the calendar list shows each node's schedules under a heading, with the overdue
mark per node, since one machine's broken autologin must not hide behind another's green.

`claude` must be installed and logged in on every node that runs sessions; `GET /api/node` reports
`claude --version` and whether Remote Control is available so the picker can grey out a node that
cannot launch.

---

## 8. Things that are per node and must look per node

- **Updates.** Each node updates itself. The update button shows per node in its heading's menu
  ("NAS: update available"), and the *what's new* comes from that node. Nodes on different builds
  are normal; `capabilities` covers the gaps, and a peer below a minimum `node-v1` is shown as
  *incompatible* rather than half-working.
- **Shells** list *that* machine's shells (`/api/shells/options` through the base) — WSL distros on a
  Windows node, `bash`/`zsh` on Linux.
- **GitHub, SSH remote files** run on and with the credentials of the node that owns the session.
- **Diagnostics** (`/api/health/environment`) per node, linked from the node heading.

---

## 9. Phases

Each phase ships on its own and leaves the app working.

| # | Phase | Delivers | Touches |
| --- | --- | --- | --- |
| 0 | **Node identity** | `node.json`, `GET /api/node`, name/colour/url in settings | server only |
| 1 | **Pairing** | `POST /api/nodes/pair`, `nodes.json`, `peers-in.json`, peer tokens in `TokenAuthMiddleware`, https peers with TOFU pinning, Settings → Nodes (add, rename, forget, revoke, re-trust a cert) | `Auth/`, new `Nodes/`, a dialog |
| 2 | **Proxy** | `/n/{id}/…` via YARP incl. WebSockets, hop guard, local-only exclusions, preview exemption, 401→502 | `Program.cs`, `Nodes/NodeProxy.cs` |
| 3 | **Node-aware SPA** | `NodeContext`/`useApi`, `sessionKey`, `?node=`; a remote session opens and works fully by deep link | `api.ts`, `App.tsx`, `SessionView`, `TerminalPane`, views |
| 4 | **Mesh & sidebar** | `NodeMesh`, `nodes[]` on `/hub/events`, node headings, offline state, search across nodes, tray submenus, push for remote sessions | `Nodes/NodeMesh.cs`, `SessionHub`, `PushNotifier`, sidebar, tray |
| 5 | **Launch anywhere** | node picker in New session, per-node folder picker/recents/templates, per-node schedules list, per-node update button | `NewSessionDialog`, `FolderPicker`, `ScheduleDialog`, `UpdateButton` |
| 6 | *Later* | cross-node projects (`folders: [{ node, path }]`), resume a conversation on another node (copy the transcript, map the folder), copy/paste files between nodes (reuse `FileTransfer`), share the peer list across the mesh, mDNS discovery, child sessions on another node from the `run-session` skill | — |

Phase 3 is the one to do carefully: after it, anything in the SPA that forgot the node silently talks
to the home node instead. A grep-able rule helps — no bare `api.` import inside node-scoped
components, only `useApi()` — checked by a script in `build.ps1`, since the web project has no linter.

---

## 10. Testing

- **Two instances on one machine** first (5099 + 5199 with `Pty:InstanceKey`, `Hooks:Enabled=false`
  on the second, as the dev setup already does) — and the second with **`HANGAR_TEST_ROOT`**, or both
  read the same `node.json` and are the same node. Both need a password (`Auth:Password`), since a
  node without one refuses to pair. Pair them, and every phase is testable without a second
  computer.
- Then a **Linux peer** (the NAS or a VM): different paths, shells and `claude` install — the cases
  that one Windows box cannot fake.
- Failure cases worth a test each: peer offline at startup, peer goes away mid-terminal, peer token
  revoked while connected, peer on an older build, cert fingerprint changed, a request trying to hop
  `A → B → C`, a `/api/self` call arriving via `/n/…` (must 404).

---

## 11. Decisions (were open questions)

1. **Projects across machines** — per node for now: the same name under two node headings is fine.
   Cross-node projects stay in phase 6.
2. **Mutual pairing is the default**, with a checkbox to make it one-way.
3. **The NAS comes early**, so `https://` peers with TOFU pinning are part of phase 1, not later.
4. **First branch** delivers phases 0–2 (identity, pairing, proxy) plus the Settings → Nodes dialog;
   the node-aware SPA (phase 3) is the next one.
