# Homeport

> **Name:** the project will be renamed to **Homeport** (the home port your remote sessions launch
> from). The rename (repo, `ClaudeWeb.exe`, namespaces) is not done yet — for now the executable is
> still `ClaudeWeb.exe`.

A .NET 10 app for Windows that **launches Claude Code CLI sessions with Remote Control enabled** so
you can drive them from the **Claude Code app** (claude.ai/code and mobile) — from any device on your
LAN. It is two programs:

- **`ClaudeWeb.exe` — the server.** A headless daemon that owns everything: the sessions, the web UI
  and its API, every store. It starts at sign-in as you — or, when it has to run while nobody is
  signed in, as a Windows service under your account — and there is one per port: launching it again
  just opens the UI.
- **`ClaudeWeb.Tray.exe` — the tray icon.** A client of the server's API, and nothing more:
  - **Left-click** → opens the web UI in your browser.
  - **Right-click** → menu listing running sessions. Each project is a submenu, and inside it the
    sessions are laid out the way the sidebar's grouped view lays them out with its active-only filter
    on: virtual folders first, then folder groups (dropped where the project links only that folder
    and there is no virtual folder to tell it apart from), forks under the session they came from, and
    no submenu for a project with nothing running in it. Click a session to open it.
  - **Exit tray** closes the icon; **Stop server…** stops the server. Neither ends a session (see
    *Sessions survive an app restart* below). The icon greys out while the server isn't running, and
    the menu then offers **Start server**.

Beside them sits **Homeport Snap** (`snap/`), a separate tray app for Windows, macOS and Linux: a hotkey
freezes the screen, you pick a region, window, screen or freeform shape, mark it up, type a message, and
send both to one of the server's running sessions — the picture lands in the prompt as a pasted image
would. It is a client of the same API and can run on any machine that reaches the server. See
[snap/README.md](snap/README.md).

The web UI is a **session manager with a full terminal**:

- **Create / select sessions** — each session is a live `claude --remote-control` process in a
  working folder of your choice.
- **Control from the Claude Code app** — launched sessions register for Remote Control and appear
  by name in the app's session list (computer icon + green dot). All interaction happens there.
- **Fork a session** — branch a conversation in two from the sessions list or the session header:
  name the fork, and it launches beside the original with the same folder and settings, picking up
  its history (`claude --resume <id> --fork-session`). The original keeps running, untouched. Forks
  nest under their parent in the sessions list, and each one's header links back to it.
- **Projects** — name a project, give it a colour, and link the folders it spans (any number,
  unrelated to each other). Projects head both session views: grouped, the folder groups sit under
  their project; flat, the sessions themselves do, with no folder headings in between. A project
  that is just one folder drops the folder heading in the grouped view too — its sessions hang
  straight off the project, since the two headings would say the same thing. Anything unfiled
  follows under *No project*. A linked folder covers everything **under** it too, so a new
  worktree or nested repo — and any session started there — joins by itself. Drag a folder group
  onto a project to move it (or onto *No project* to take it out), or use the folder's ⋯ menu. The
  **+** on a project heading starts a session in it: the create dialog offers the project's linked
  folders as one-click picks (filling it in when there's only one) and still takes any other folder.
  Stored server-side, so projects follow you across devices.
- **Virtual folders** — named boxes inside a project, each with its own colour and icon, holding
  sessions you put there by hand. The folder a session runs in is often the wrong unit: three
  sessions in one repo can be three unrelated errands, and two sessions in different repos can be
  one piece of work. Add them in the project's settings, then **drag a session onto a box** to file
  it there. The row's ⋯ menu offers the same move without a drag — the only way on touch — listing
  the project's groups the way it lists its projects, with **New group…** at the end: name it, give
  it a colour and an icon, and the session you opened the menu from is in it. Drag it back
  onto the project heading to take it out. A filed session is drawn in its box and nowhere else, so
  the folder groups thin out as you use them; the boxes sit above the folder groups in both views,
  and fold away like any other heading. A session can only go into a box of the project its own
  folder belongs to — a group refines where a session sits, it never moves it between projects — so
  a folder that later leaves the project quietly hands its sessions back to the folder grouping,
  and putting the folder back brings the grouping back with it. Membership is keyed by the
  conversation, like a pin, so it survives reopening the session, and lives server-side alongside
  the project. A session launched from one that is filed — a fork, or a child session started under
  it — goes into the same box, so a branch is drawn under the session it came from instead of
  falling out of it into the folder grouping. A child session started in a folder no project
  claims takes its host's project too: the link is the only way to say which project a session is
  in, and a child launched into another repo would otherwise land under *No project*, away from
  the session that started it. A folder another project already claims is left where it is.
- **Session templates** — a saved way to start the *same kind* of session again: a project, a folder,
  a prompt, and the launch settings that go with them. The same errands come back week after week —
  *look into this log entry*, *review this support request*, *ship this Jira issue* — and each one is
  the same launch every time except for one detail. A template holds everything but that detail.
  The **New session** dialog has a **Templates** tab beside the form: the templates listed under
  their projects, and under the one you pick a single box for what this run is about. Paste the error
  in, hit Create, and the session starts in the right folder with the prompt already sent. Where the
  detail lands is the template's business: `{input}` in the prompt is replaced by what you typed (so
  `/fix-issue {input}` becomes a slash command with the key in it), and a prompt without
  the placeholder gets it appended as a paragraph at the end. *What Claude will be sent* shows the
  result before you launch. Everything the template decided — folder, name, model, permission mode —
  is still there under **Session settings**, folded away, and changing it there changes this run
  only. Write them from the same tab (**New template**) or from a project's settings, where the
  project's templates are listed beside its groups. Stored server-side like projects, so they follow
  you across devices.
- **Schedules** — a template plus a clock, so the errands that come back on their own run on their
  own. The calendar button in the sidebar's toolbar lists them; each one picks a template, a clock,
  and what a run actually *is*:
  - **One-shot (headless)** — `claude -p` runs once and exits. No session row, nothing accumulates,
    and the output is kept in the schedule's history. The right shape for the frequent stateless
    check ("is the deploy green?"), and the one to reach for before the other two.
  - **New session each run** — a full interactive session per fire, as if you had filled in the New
    Session dialog. **Stop when done** closes it once its turn ends (the Stop hook is what says so),
    and **sessions to keep** drops the older runs, so a daily schedule doesn't leave thirty rows
    behind it.
  - **Continue an existing session** — sends the prompt into a session already running, keeping one
    conversation's context. Its clock is *not* a wall clock: it fires **N minutes after the last turn
    finished**, which is what makes a run unable to land on top of the one before it. It never types
    over a permission prompt, and a prompt it cannot deliver is stashed in that session's
    **postponed messages** rather than dropped — so the badge says a schedule has been stuck instead
    of the silence saying nothing. Worth knowing: one conversation poked every few minutes grows
    until it compacts and drifts, so anything that doesn't truly need the history holds up far
    better as a one-shot.

  The clock is a five-field cron read in a stored timezone (you edit these from a phone, which may be
  somewhere else), with presets for the usual shapes. A fire the machine was **off or asleep** for
  runs once on the next start if it is inside its grace window — several missed slots still produce
  one run, not one each. **Run now** fires one without touching its clock, which is how you check it
  does what you meant before leaving it to run at 03:00.

  Schedules live in the server, so they survive a restart of the app and a reboot — as reliably as
  the server itself starts (**Start at sign-in** below, with autologin, or a user systemd/launchd
  unit elsewhere). That ceiling is why every row leads with **when it last ran** and flags itself
  **overdue**: a schedule silenced by a broken autologin otherwise looks exactly like one with
  nothing to do. A session a clock started wears a calendar mark before its name, beside the fork
  mark — "a clock did this" is provenance, not activity.

  Runs are unattended, so the template's **permission mode** is doing real work: a run that hits a
  permission prompt just sits there, and the watchdog deliberately won't answer it. Web Push already
  fires on "newly waiting on a prompt", so a 03:00 run that blocks wakes your phone.
- **Folder picker** — autocomplete over the *server machine's* filesystem, with keyboard
  navigation (↑/↓/Enter) and recently-used folders.
- **File browser** per session — a lazy directory tree on the left, preview on the right:
  - **Text/code** files rendered inline and **editable** (Edit → Save writes the file);
    **images** with a full-page **zoom/pan** lightbox; **Markdown** rendered (Rendered/Raw toggle);
    anything else is downloadable.
  - **Git**: if the folder is a repo, the current **branch** is shown, changed files are
    **marked** (M/A/U/D) in the tree, and each changed file has a **Diff** view.
  - **Search** the whole tree, **download** any file, and the tree **auto-refreshes** as files
    change on disk (via a filesystem watcher) while preserving expanded folders.
  - **Linked folders** — attach extra folders to a session and browse/edit them from the same panel
    via the root picker. Saved server-side against the session's working folder, so they survive a
    restart (and a resumed session's new id).
- **Shell tabs** per session — a real shell in the session's folder, beside the Claude terminal and
  the files, opened from the **+** at the end of the tab bar. The chevron next to it lists what the
  *server machine* actually has: **PowerShell 7**, **Windows PowerShell**, **Command Prompt**,
  **Git Bash**, and one entry per installed **WSL distribution** (a WSL tab opens with `--cd`, so it
  starts in the same folder as `/mnt/c/…`). A bare **+** reopens whichever you picked last. The tabs
  live server-side, so they show up on every device looking at that session — and each one runs in
  its own pty host, so a build left running in a shell **survives a restart of the app** exactly as a
  session does. Closing a tab kills what's in it; stopping the session closes its shells with it.

  The **Files** tree offers the same thing for any folder, session or not: the terminal button on a
  folder row (and in the panel's toolbar, for touch) opens that folder's shells in the main area,
  where a previewed file would go. It starts one straight away and takes the same **+** for more.
  A folder's shells are its own — a session running in the same folder keeps its tabs in its own tab
  bar — and closing the last one hands the main area back.
- **Web links** — the page a session is working *from* — the Jira issue, the PR, the spec — pinned
  to its tab bar by the **+** at the end of the row. Paste an address (the `https://` is optional);
  the page is named and given its favicon automatically, and clicking its tab shows it in the pane
  beside the terminal. Links live server-side against the conversation, like the open file tabs, so
  they follow the session to every device and survive a reopen. Double-click a tab (or the pencil in
  its toolbar) to rename or re-point it.

  **Not every site can be shown.** Most SaaS worth linking to — Atlassian, GitHub, Google — sends
  `X-Frame-Options` or a CSP `frame-ancestors` that forbids being framed by anyone else, and a
  browser obeys that by drawing nothing at all, with no error a page can catch. So the server reads
  those headers before the tab exists (`GET /api/web/link-probe`) and says so in the add dialog: a
  page that refuses framing becomes a **bookmark tab** instead, marked with an arrow, whose pane
  names the page and opens it in a browser tab in one click. You can force either behaviour with the
  *Show the page in the tab* checkbox. A page that does frame but needs you signed in may still ask
  again — a frame is a separate context as far as the browser's cookie rules go.
- **GitHub pull requests** — a session whose folder is a GitHub repo gets a **PRs** button right
  after *Files*, and the repo's pull requests one click behind it: **Open** ones by default, with
  **Closed** (which includes merged) and **All** on the tabs beside it, and a box that filters the
  list by number, title, author or branch. Pick one and it opens as a **tab of its own** — `#42` and
  the title — right after the Files tab, and stays there: the open reviews live server-side against
  the conversation like the linked pages do, so a PR opened on the laptop is on the phone too, and a
  reload finds it where you left it. Eight at once is the cap, and a ninth pushes out the oldest tab
  rather than refusing — a row of reviews being worked through is what the tabs are for.

  The tab is a **review**: the changed files down a collapsible left sidebar, and the diffs beside
  them, old on the left and new on the right the way GitHub draws them. Each file folds away by its
  header (and the header stays put as you read through it); clicking one in the sidebar opens it and
  scrolls to it. Both dividers drag: the one beside the file list, and the one down the middle of a
  diff — that one sets the ratio for **every** file at once, so the two columns stay in step down the
  page. Double-click either to put it back. (The middle divider is for the wrapped view; unwrapped,
  the halves are as wide as their longest line and scroll together, and there is no width to divide.) **A file that was added has no left side to show**, so it isn't given one — the new
  content is drawn as a single full-width column, and a deleted file the same way round. Long lines
  wrap by default, because this pane is often half a screen wide rather than a whole one; the button
  in the header turns that off for GitHub's own behaviour, where the two halves scroll together.
  The **−/+** beside it sizes the code, on the same stops every other zoomable view in the app uses,
  and the percentage resets it. It sizes the code and nothing else: the file paths, the sidebar and
  the header stay where they are, because the point is reading a diff on a laptop screen rather than
  rescaling the furniture around it.

  Both are **syntax highlighted**, in the same palette the file preview uses. Each side of a diff is
  coloured as one text rather than a line at a time, so a comment or a string running over several
  lines is still one of those where it is drawn — what a diff cannot show is the code between hunks,
  so a block opened in a part of the file nobody touched reads as closed. A whole file has no such
  gap and is coloured exactly as a compiler would read it.

  Every file's header also offers **Diff / File**: the change, or the file itself, read whole at the
  commit this pull request proposes — the base commit for a file the request deletes, since that is
  the only side it still exists on. A file being read whole gets a **copy** button beside the toggle,
  which is where copying belongs: a diff copied wholesale is a mix of both sides with markers down
  the left, which is not the file anyone means.

  The counts under the title end in **N commits**, which is GitHub's *Changes from* menu: the whole
  pull request first, then each commit oldest first. Pick one and the review narrows to what that
  commit alone changed — same diffs, same *File* view (read at that commit, or just before it for a
  file it deletes) — with the commit's message where the description was and arrows to step to the
  commits either side. *All changes* goes back, to the place in the review you left. A commit's folds
  and scrolling are its own and are not remembered, and the *Viewed* boxes stay with the whole
  review, since a mark says a file has been read as the pull request proposes it.

  Each file has a **Viewed** box, the way GitHub's has: tick it and the file folds away, and the
  header keeps the count. Ticked at the end of a long file, the pane goes back to that file's header,
  so the next file starts right below it rather than somewhere off in its middle. The marks are held against the *pull request* rather than the session, so
  they are the same in every browser, outlast the session being closed and reopened, and are shared
  by every session working in that repo. A mark records the file's blob as it was when you read it,
  which is what makes a push reset **only the files it touched** — the rest of the review stays read.

  **Comments for the session's Claude.** Select some lines in a diff, or in a file read whole, and a
  **Comment** button appears under them. It turns the selection into whole lines on one side — a
  drag in a split diff stays in the column it started in — and opens a small card to say what
  should change. **Send now** (Ctrl+Enter) puts the comment straight into the session's terminal,
  with the file, the line numbers and the lines themselves. **Add to review** (Ctrl+Shift+Enter)
  keeps it in the pull request's review file instead, `.claudeweb/reviews/<repo>-pr-<n>.md` in the
  session's folder, and a **Review** count appears in the header. That opens the file for a last
  read: it is plain Markdown and exactly what will be sent, so edit it freely, then **Send review**
  hands the whole of it to the session as one message and deletes the file. Lines on the old side
  are said to be the old version's, and in a single commit's view, that commit's. A closed session
  still collects comments; sending waits until it is running.

  How far through a review you had got is kept: which files you folded away, and where the pane was
  scrolled to, against the repo and number of the pull request in the session's own state — so it follows the session to
  your other devices, and a tab that goes away takes it with it, whether you closed it or it made
  way for a ninth. *Collapse all* and *Expand all* are stored as that, one word, rather than as a
  decision per file; the files you then fold or open one at a time are stored by name, and a session
  keeps a hundred of those across all its reviews before the oldest go back to following the rest.

  A review is fetched when its tab is first opened and then stays as it was, so one left open behind
  the terminal is as old as when you last looked at it — the **reload** in its header is what catches
  it up. A file whose diff is enormous arrives folded rather than drawn, and one past the size the
  server will send is listed with its counts and left on GitHub.

  **A session is not limited to the repo it sits in.** Claude changes one repo in answer to another
  often enough, and a folder opened a level up over several checkouts has no remote of its own to
  speak for it — so the top of the picker is a strip of the repos this session can review, and the
  **+** beside it links another by name (`owner/name`) or by pasting its URL. Nothing is checked out
  to do it: gh answers for any repo by name, so a repo you only have to read is one line of typing.
  Pick a repo in the strip and the list below is its pull requests; a review opened from one that
  isn't the session's own says which repo it is in, on its tab and in the picker, since `#42` of two
  repos would otherwise read as one review. The strip also carries the repos of the **project** the
  folder belongs to — *Linked repositories* in the project's settings — which is where a repo the
  whole project cares about belongs, rather than being linked again in every session under it. Only
  what a session linked itself can be unlinked from the strip; its own folder's repo is a fact about
  the folder, and a project's is the project's to take back. A session with **no** repo at all has no
  button in the bar — *Pull request…* in the **+** menu opens the same popup, which is where its
  first repo gets linked.

  It all runs through the **`gh` CLI on the server machine**, which is what makes it work without a
  token of its own: gh already holds your GitHub credentials and resolves the repo from the folder's
  remotes. `gh auth login` there is the whole of the setup, and whatever gh says when it can't answer
  — not installed, not signed in, no such repo — is what the picker says back. Whether a folder is a
  GitHub repo at all is read from its git remote, so a session in a folder that isn't one starts with
  an empty strip, and nothing on the network was asked to find that out.
- **What each session is doing** — every row carries a mark, read off Claude's own hook callbacks
  rather than scraped off the terminal: a green pulse while it works, a cooler one while it compacts,
  an **amber ring** when it is blocked on you, a **red cross** when the last turn died on an API
  error, and a green tick for a turn that finished while you were looking elsewhere (that one clears
  once you have read it). The two that want you name themselves: hover a waiting row and it says
  which command the permission dialog is asking to run — *Wants to run Bash: git push --force* — and
  a failed one says what it died on, a rate limit being the usual answer. A failed turn is worth its
  own mark because it is invisible otherwise: a turn that hit its limit stops printing exactly like
  one that finished, so without this the session just looks done. Both also raise a notification —
  in the page, and as a Web Push alert to every subscribed device, so the phone gets it with every
  tab closed — carrying the same line. A folder or project heading shows the most urgent mark under
  it, so a collapsed group can't hide a question.
- **Responsive** — collapsible session sidebar on desktop; a slide-over drawer on mobile.
- **Light / dark** theme toggle.
- **Start / stop** — stop kills the process; the app just manages lifecycle.

## How a session is launched

`claude` insists on an **interactive** terminal: without one it falls back to non-interactive
`--print` mode, the TUI never renders, and Remote Control never registers. So every session is
attached to a Windows **pseudoconsole** (ConPTY) — a real terminal as far as the child is concerned,
whose VT stream we pipe out and render in the browser with xterm.js. The same session can also be
driven from the Claude Code app over Remote Control; both are views of one process.

Each session is launched as:

```
claude --remote-control <name> --name <name> [--model <m>]
```

The pseudoconsole is owned by a per-session `ClaudeWeb.PtyHost.exe` rather than by the app itself,
which is what lets a session outlive an app restart — see **Architecture** above.

Permission mode is chosen per session at launch. The default leaves decisions to the Claude Code app;
`bypassPermissions` passes `--dangerously-skip-permissions`, whose one-time acceptance screen would
otherwise block startup, so the app pre-accepts it.

## Architecture

```
Browser (React + Vite + TS + Tailwind + shadcn/ui)       ClaudeWeb.Tray.exe  (tray icon, WinForms)
   │  REST /api/*     ──►  auth, session create/list/stop,  │  the same REST + /hub/events, with a
   │                       filesystem browse                │  per-run token from the instance file
   │  WS /hub/events  ──►  live session list                │
   │  WS /hub/sessions/{id}/terminal  ──►  xterm.js         │
   ▼                                                        ▼
ClaudeWeb.exe  (the daemon: ASP.NET Core Minimal API, headless)   ← restarts, updates and crashes freely
   │  started at sign-in as the user, or as a Windows service under the user's account
   │  named pipe \\.\pipe\claudeweb-pty-<instance>-<sessionId>
   ▼
ClaudeWeb.PtyHost.exe   (one per session — and one per shell tab — detached; owns the pseudoconsole)
   │  ConPTY + 512 KB scrollback ring + fan-out + the hang watchdog
   ▼
claude --remote-control <name> --name <name>
   │  registers with api.anthropic.com  ──►  appears in the Claude Code app
   ▼
You drive it from the in-app terminal, claude.ai/code, or the Claude mobile app
```

The pty host is the reason a session **survives a restart of the app**. A pseudoconsole (`HPCON`)
cannot be handed to another process, and its `conhost` is bound to whoever created it — so the only
way to keep a session alive across an update is for the process that owns the pseudoconsole not to be
the process that restarts. The daemon attaches and detaches; the host holds the session.

The tray is split off from the daemon for a similar reason, one level up. The daemon has nothing to
draw, so it can run before anyone signs in, and a tray that crashes or is closed takes nothing with it.
The tray finds the daemon through an **instance file**: once listening, the daemon writes
`%LocalAppData%\ClaudeWeb\instances\<port>.json` — its pid, its loopback and public URLs, and a bearer
token minted for that run — and removes it on the way down. The file is created readable by your account
alone (an explicit ACL, not whatever the folder passes down), the token grants nothing that account
couldn't already read in the same folder (the browser tokens live there too), and loopback stays
authenticated for every other process on the machine.

## Prerequisites

- Windows 11, **.NET 10 SDK**, **Node 20+**
- **Claude Code v2.1.51+** installed and authenticated (OAuth / claude.ai login) for your user
  account. Remote Control requires a Pro/Max/Team/Enterprise plan.
  - If you have **multiple claude installs**, the app uses the first `claude` on `PATH`. Make sure
    that's the up-to-date one (`claude --version`), or pin the full path via
    `Sessions:ClaudeExecutable` in `appsettings.json`.

## Develop

```powershell
# Windows PowerShell (pwsh 7 also works):
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
# Backend  → http://127.0.0.1:5099
# Frontend → http://localhost:5173  (proxies /api to the backend)
```

Since the SPA is built into the backend's `wwwroot`, you can also just run the backend and use it
directly at its port — no Vite needed:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run.ps1
```

Neither starts the tray. It follows a server by port, and picks one up whenever it starts listening:

```powershell
dotnet run --project tray                  # follows 5099
dotnet run --project tray -- --port 5199   # follows a dev server on 5199
```

### Running a second instance beside the installed app

`~/.claude/settings.json` is **global**: every Claude Code session on the machine posts its tool-use
events to whichever `/api/hooks` port is registered there. A second instance on another port used to
claim that registration silently, so stopping it left every session on the machine failing every
tool call with `hook error connect ECONNREFUSED`.

Two things now prevent that, and it is worth knowing both:

- **The instance stands down.** Before registering, it checks whether something is still listening on
  the port the hooks currently name. If so it leaves them alone and logs why — its own session status
  falls back to terminal heuristics, which is the right trade. A registration whose port is dead is
  still taken over as before, so an ordinary port change needs no intervention. `Hooks:Force=true`
  overrides the check.
- **The debug paths don't ask.** The `ClaudeWeb (debug 5199, no hooks)` launch profile sets
  `Hooks__Enabled=false`, and `scripts\dev.ps1 -Port <other>` passes `--Hooks:Enabled=false` for any
  port that isn't the app's own `5099` (`-Hooks` forces it back on). On 5099 it registers normally,
  since that is the registration the installed app wants anyway.

Note that `dotnet run` applies the launch profile by default — that env-var `Server__Urls` is what
the hook port is read from, so `--urls` on the command line alone does **not** change it.

Set the login password by putting it in `server/appsettings.json` (`Auth:Password`) and starting
the app once — it hashes the password to `%LocalAppData%\ClaudeWeb\auth.json` and logs a reminder
to clear the plaintext. After that first run, blank `Auth:Password`; the persisted hash is used
for login and no recoverable password is left on disk.

## Build and install

```powershell
# Builds the SPA and publishes ClaudeWeb.exe, ClaudeWeb.Tray.exe and ClaudeWeb.PtyHost.exe into .\publish
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

Output: three self-contained exes in `publish\` (no .NET runtime needed) plus `wwwroot\` and
`appsettings.json` beside them. Edit `appsettings.json` to set `Auth:Password` (hashed on first
launch — see above) and `Server:Urls` (port). The tray reads its port from the same file, so the two
stay paired; a tray for another port takes `--port <n>`.

**Start at sign-in** — the recommended setup (current user, no admin needed):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1 -ExePath .\publish\ClaudeWeb.exe
# the server only, no tray icon:
powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1 -ExePath .\publish\ClaudeWeb.exe -NoTray
# remove both later:
powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1 -Remove
```

That adds `ClaudeWeb` and `ClaudeWeb.Tray` to your per-user Run key. To start them now, run
`ClaudeWeb.exe` and then `ClaudeWeb.Tray.exe`; the icon lights up once the server is listening.

Why at sign-in rather than as a service: the server never logs in to anything — it *inherits* a login.
`claude`'s credentials, its settings and its trust list all live in your profile, as does every store
this app keeps. Started at sign-in it runs as you, in your session: the same profile, the same PATH,
and a desktop to open a browser on if `claude` ever needs you to log in again.

Browse to `http://<this-pc>:5099` from any device on your network, launch a session, and pick it up
in the Claude Code app.

**Upgrading from the single-exe build.** `ClaudeWeb.exe` used to be the tray and the server in one.
An existing `ClaudeWeb` autostart entry keeps working — it now starts the server — but nothing starts
the tray until you run `register-autostart.ps1` once more.

## Optional: run as a Windows service

For a server that has to keep running while nobody is signed in:

```powershell
# Install as a service under your user account (elevated prompt; prompts for your password)
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -PublishPath .\publish
# Uninstall
powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1
```

The same exe detects it's running under the service manager, and the tray works against it just the
same (the tray itself still starts at sign-in, in your session). Two things to know first:

- **Log in to `claude` interactively before installing.** A service runs in session 0, where `claude`
  can't open a browser, so the service should only ever read a login you have already made.
- **Mapped drives aren't visible** to a service — they belong to a logon session. Use UNC paths for
  project folders and for `FileSystem:DefaultFolder`.

## Checking what the server runs as

Sessions that won't authenticate, a `claude` that "isn't installed", folders that come up empty: these
usually mean the server is running as a different identity, or with a different environment, than the
one you use `claude` from. The server reports its own at startup — one `Environment:` line in
`%LocalAppData%\ClaudeWeb\logs\claudeweb.log`, plus a warning for each problem it finds — and on demand:

```bash
# any logged-in browser's token, or the "token" in %LocalAppData%\ClaudeWeb\instances\<port>.json
curl -H "Authorization: Bearer <token>" http://localhost:5099/api/health/environment
```

It names the user, whether it is a service (and which Windows session), the `claude` and `git` it
resolved, the profile and app-data folders, and whether `~/.claude/settings.json`, `~/.claude.json` and
`claude`'s credentials file exist there and can be read.

## Updating from inside the app

`scripts\deploy.ps1` builds and installs in one shot, which means it stops the app from the machine
it runs on. The in-app updater splits that in two, so a new build can be published from anywhere and
installed with a click in the UI:

```powershell
# Build and publish a pending update. Does NOT touch the running app.
powershell -ExecutionPolicy Bypass -File scripts\stage-update.ps1
```

That drops the published build into `C:\apps\claude-web-updates\payload` (override with `-Staging`).
The running app watches that folder, compares the staged `build.json` with its own, and puts an
**Update** button next to the "Claude Web" title in the sidebar as soon as they differ. Clicking it
shows both build stamps and, on confirmation:

1. the server answers the request, then stops itself — gracefully, detaching from each session's pty
   host, so the sessions themselves keep running;
2. the tray hears the update coming over `/hub/events` and steps aside: it exits so its exe can be
   replaced, leaving a small detached PowerShell to start it again once the new server answers;
3. a detached `apply-update.ps1` (embedded in the exe, extracted to `%LocalAppData%\ClaudeWeb\update`)
   waits for the server to exit, mirrors the payload over the install folder and restarts the server
   the same way it was running — the service if there is one, otherwise `ClaudeWeb.exe`;
4. the sessions that were running are re-attached, exactly as after a `deploy.ps1` redeploy (one
   that did die is resumed instead — see `Sessions:ResumeOnStart`);
5. the browser sits behind an "Installing the update…" overlay until the new build answers, then
   reloads so it picks up the new frontend assets too.

`appsettings*.json` in the install folder are preserved, never overwritten by the payload. The
updater logs every step to `%LocalAppData%\ClaudeWeb\logs\update.log`, and on any failure it restarts
the app rather than leaving the machine with nothing running.

Staging is safe at any time — it only writes to the staging folder, and the payload is swapped into
place at the end so the app never reads a half-copied build. Set `Update:Enabled` to `false` to turn
the whole thing off and go back to `deploy.ps1` only.

## Notes & gotchas

- **Workspace trust.** A brand-new folder normally triggers Claude's one-time trust prompt, which
  would block an unattended launch. With `Sessions:AutoTrustFolders` on (default), the app
  pre-accepts trust for the folder before launching by adding `hasTrustDialogAccepted` to
  `~/.claude.json` (it backs the file up once to `~/.claude.json.claudeweb-backup`, writes
  atomically, and only adds entries for folders not already present). Set it to `false` to disable
  and accept the prompt manually from the Claude Code app instead.
- **Sessions survive an app restart.** Each session's pseudoconsole lives in its own detached
  `ClaudeWeb.PtyHost.exe`, so an in-app update, a `deploy.ps1`, the tray's **Stop server** or even a
  crash of the server leaves the session running — and closing the tray never touches a session at
  all. On the next start the server **re-attaches** to it: same session id, scrollback
  replayed into the terminal, and a conversation that was mid-turn simply carries on. Nothing is
  relaunched and no `--resume` is issued. What ends a session is **Stop** in the UI, `claude` exiting
  on its own, or the machine rebooting.
- **Auto-resume after a reboot.** A ConPTY child cannot survive a reboot, so for that case the
  persisted launch metadata still does the work: on the next start the app **relaunches the sessions
  that were running**, each resuming its own conversation (`--resume <id>` when Claude's session id
  was captured from a hook, else `--continue`). The original prompt is not re-fired and the watchdog
  setting is carried over; a relaunched session gets a **new id** in the UI. Sessions that had
  already exited on their own are not resurrected, and a folder that's gone (or a failed launch)
  just stays a manual **Reopen** entry. Turn it off with `Sessions:ResumeOnStart=false`, or per
  launch with `--no-resume-sessions`. Pair it with **Start on login** above and a reboot restores
  your working set by itself.
- **Hang watchdog.** Claude Code sometimes stalls on an API or streaming error and sits there. When
  a session opts in, the watchdog notices the error banner on screen and writes `continue` for it. It
  never acts while Claude is emitting (that covers Claude's own retry) or while a permission prompt
  is on screen, waits out `Watchdog:CooldownMs` between attempts, and after `Watchdog:MaxConsecutive`
  tries gives up and flags the session for **attention** in the sidebar instead. Toggle it per
  session in the UI; a manual **Continue** clears the give-up flag.

  It runs **inside each session's pty host**, not in the web app — so a session that stalls overnight,
  or during an in-app update, is recovered whether or not the app is running, and you see what
  happened when the browser reconnects. A host keeps the options it was launched with, so a change
  under `Watchdog:` in `appsettings.json` applies to sessions started after it.
- **Shells survive an app restart too**, for the same reason sessions do — each shell tab is its own
  pty host — so a build or a `tail -f` left running in one is still going, and still streaming, after
  an update. They are namespaced separately (`<instance>-sh`), which is what keeps a shell from
  showing up in the sidebar's orphaned-session list. What they do *not* get is auto-resume: a shell
  whose process is gone (a reboot) is simply forgotten, since its value was the scrollback and the
  state in it, and both died with it.
- **Shell arguments go out verbatim.** The pty library quotes every argument, which most programs
  unquote again — but `wsl.exe` parses its own command line and reads `"-d"` as a *command* to run,
  so a WSL tab came up as `bash: -d: command not found`. Shells are therefore spawned with
  `PtySpawnRequest.VerbatimArguments`, quoting only the tokens that need it (a path with spaces).
  The `claude` launch is unchanged and still uses the quoted path.
- **Keep the process alive.** Remote Control lives in the launched `claude` process; stopping it
  (or the machine going offline for ~10 min) ends the session in the app.
- **`ANTHROPIC_BASE_URL`** must be unset / pointed at `api.anthropic.com`, or Remote Control is
  disabled (Claude Code v2.1.196+).

## Configuration (`server/appsettings.json`)

| Key                         | Meaning                                              | Default              |
| --------------------------- | ---------------------------------------------------- | -------------------- |
| `Server:Urls`               | Kestrel bind address(es); `0.0.0.0` = LAN-reachable  | `http://0.0.0.0:5099`|
| `Auth:Password`             | Bootstrap-only plaintext; hashed to `auth.json` on start, then clear it. Empty (with no stored hash) = **no auth** (dev only) | `""` |
| `Auth:ApiKey`               | API key for `POST /api/external/sessions`. Empty = off| `""`                 |
| `Sessions:ClaudeExecutable` | Path or command for the CLI (pin a full path here)   | `claude`             |
| `Sessions:AutoTrustFolders` | Pre-accept Claude's workspace-trust prompt per folder| `true`               |
| `Sessions:ResumeOnStart`    | On start, relaunch the sessions that were running at the last exit | `true` |
| `Sessions:ResumeDelayMs`    | Settling delay before auto-resume starts (lets a booting PC come up)| `5000`  |
| `Sessions:ResumeStaggerMs`  | Pause between consecutive auto-resumed launches      | `2000`               |
| `Sessions:SelfUrl`          | URL a session calls back on (`CLAUDEWEB_URL`); empty = derived from the bound port | `""` |
| `Hooks:Enabled`             | Register this instance's hooks in `~/.claude/settings.json` (drives busy/waiting/failed status). Off = terminal heuristics only | `true` |
| `Hooks:Force`               | Claim that registration even when another instance is live on the port it currently names — see below | `false` |
| `Pty:InstanceKey`           | Namespaces this instance's pty pipes and state dir; empty = the bound port. Keeps a dev instance from adopting the live app's sessions | `""` |
| `Pty:HostExecutable`        | Path to `ClaudeWeb.PtyHost.exe`; empty = beside the app | `""`                 |
| `Pty:AttachTimeoutMs`       | How long a host has to answer its pipe before its state file is called stale | `3000` |
| `Pty:StartTimeoutMs`        | How long a freshly launched host has to come up and accept a connection | `20000` |
| `Pty:OrphanMaxAgeHours`     | Auto-stop untracked sessions older than this; `0` never does (they are listed in the sidebar and tray instead) | `0` |
| `Schedules:Enabled`         | Master switch for the clock; off means no schedule ever fires | `true`      |
| `Schedules:MaxConcurrentRuns` | Most scheduled runs in flight at once, across every schedule | `4`         |
| `Schedules:DoneAfterIdleSeconds` | How long a run must sit idle before **Stop when done** stops it | `20`   |
| `Schedules:RestoreWaitSeconds` | How long to wait for a reopened session's terminal before giving up on poking it | `45` |
| `Watchdog:Enabled`          | Master switch for auto-recovery; off means no host ever auto-continues | `true` |
| `Watchdog:PollIntervalMs`   | How often a host re-examines its own session      | `2000`               |
| `Watchdog:CooldownMs`       | Minimum gap between auto-continues for one session| `20000`              |
| `Watchdog:MaxConsecutive`   | Attempts before giving up and flagging for attention | `3`               |
| `Watchdog:SendSequence`     | What is typed to recover, and by the manual **Continue** button | `continue\r` |
| `Watchdog:ErrorPatterns`    | Case-insensitive regexes that mean "this session looks hung" | (API/stream errors) |
| `Watchdog:PromptGuardPatterns` | Regexes for an on-screen prompt; any match and the watchdog stays silent | (dialog wording) |
| `Update:Enabled`            | Offer in-app updates staged by `scripts\stage-update.ps1` | `true`           |
| `Update:StagingPath`        | Folder updates are staged into (the build lands in its `payload` subfolder) | `C:\apps\claude-web-updates` |
| `Update:PollSeconds`        | Re-read the staged build this often (a watcher already catches it sooner) | `30` |
| `Update:InstallPath`        | Install folder to update; empty = the folder the running exe is in | `""`   |
| `Update:ShutdownWaitSeconds`| How long the updater lets the app close before forcing it down | `45`       |
| `FileSystem:DefaultFolder`  | Folder the picker opens at when creating a session   | `C:\Git`             |

## Programmatic session creation (API)

An external program (script, CI, automation) can launch a session without the browser login via
`POST /api/external/sessions`, authenticated with an **API key in the `X-Api-Key` header**. Set
`Auth:ApiKey` in `appsettings.json` to enable it (empty = the endpoint is disabled). The JSON body
is exactly what the "New session" dialog sends:

```bash
curl -X POST http://<this-pc>:5099/api/external/sessions \
  -H "X-Api-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "workingDirectory": "C:\\Git\\myproject",
    "name": "nightly-build",
    "remoteControl": true,
    "model": "opus",
    "initialPrompt": "run the tests and fix any failures",
    "permissionMode": "auto"
  }'
```

Only `workingDirectory` is required. `model` is `opus`/`sonnet`/`haiku` (or omit for default),
`permissionMode` is `auto`/`default`/`acceptEdits`/`bypassPermissions`. On success it returns
`201` with the session JSON (same shape the UI uses); the session then appears in the web UI and,
if `remoteControl` is true, in the Claude Code app. The key authorizes `/api/external/*` only — the
rest of `/api/*` still requires the browser bearer token.

**Talking to a session you started.** `POST /api/external/sessions/{id}/message` sends one message to
a running session's Claude, exactly as typing it into the terminal would — the text goes in as a
bracketed paste, so newlines in it stay part of the one message instead of submitting a line at a
time, and a single Enter follows it:

```bash
curl -X POST http://<this-pc>:5099/api/external/sessions/<id>/message \
  -H "X-Api-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"text": "now open a PR for that"}'
```

`200` when it was delivered, `404` when the id names no *running* session. Sending several in a row
needs a gap of ~150 ms between them, or Claude Code's input box merges them into one message. The
browser's own route for this is `POST /api/sessions/{id}/message`, behind the bearer token.

## Renaming a session from inside it (API)

A running session can rename **itself**, so a `claude` command (or a hook, or any script the session
runs) can name the session after the work it turns out to be doing. `POST /api/self/name` needs no
browser login and no API key: every session ClaudeWeb launches already carries its own credentials in
its environment, and they are all the call takes.

| Env var                | What it is                                                       |
| ---------------------- | ---------------------------------------------------------------- |
| `CLAUDEWEB_URL`        | Base URL of the app, on loopback (e.g. `http://127.0.0.1:5099`)  |
| `CLAUDEWEB_SESSION_ID` | This session's id — also the session the call renames             |
| `CLAUDEWEB_HOOK_TOKEN` | Local secret that authorizes the call (also used by the hooks)   |

```bash
curl -s -X POST "$CLAUDEWEB_URL/api/self/name" \
  -H "X-Session-Id: $CLAUDEWEB_SESSION_ID" \
  -H "X-Hook-Token: $CLAUDEWEB_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"refactor auth middleware"}'
# {"id":"664d6618…","name":"refactor auth middleware"}
```

The name is stripped of control characters, trimmed, and capped at 100 characters. Responses are
`200` with the applied name, `400` when the name is empty, `401` when the headers are missing or
wrong, and `404` when the id names no session.

The token is minted once and kept in `auth.json`, not regenerated per app run. A session's
environment is fixed when its `claude` process starts, and that process outlives the app — a restart
or a redeploy re-adopts the still-running session but cannot re-inject anything into it — so a
per-run secret left every surviving session silently 401'ing on this endpoint and on its hooks.
Sessions launched *before* this changed still carry a token that no longer exists: their self-rename
fails with `401` (logged server-side) until they are restarted, and typing `/rename <name>` in the
terminal is the way to rename them in the meantime.

The effect is exactly the sidebar rename: the display name changes everywhere and `/rename <name>`
is injected into the session's terminal so Claude's own conversation title follows. A session that
renames itself *mid-turn* has that `/rename` land in its own input queue, so Claude runs it once the
current turn finishes.

The session id comes from the header we injected at launch, so a session can only ever rename
itself — the endpoint can't be aimed at another session, and it stays shut to anything that can't
read that session's environment. Same trust boundary as the `/api/hooks` callback.

## Opening a file in a session's tab bar from inside it (API)

The same trust boundary, put to a second use: a running session can open a file of its own working
directory as a **tab in its own tab bar**, next to Terminal/Split/Files, the way clicking it in the
Files panel would. `POST /api/self/open` takes the same three environment variables as the rename
above, and nothing else.

```bash
curl -s -X POST "$CLAUDEWEB_URL/api/self/open" \
  -H "X-Session-Id: $CLAUDEWEB_SESSION_ID" \
  -H "X-Hook-Token: $CLAUDEWEB_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths":["server/Program.cs","web/src/App.tsx"]}'
# {"id":"664d6618…","opened":["server/Program.cs","web/src/App.tsx"],"missing":[],"active":"web/src/App.tsx"}
```

`path` (one string) and `paths` (an array) are both accepted and add up; the last file opened
becomes the active tab. Paths are relative to the session's working directory — an absolute path
inside it is fine too — and anything that escapes it, names a folder, or isn't there comes back in
`missing` rather than opening. `"pin": false` puts the file in the single transient *preview* slot
that a click in the tree reuses, instead of giving it a tab of its own.

Responses are `200` with what opened, `400` when no path was given or none of them resolved,
`401` on missing/stale headers, and `404` when the id names no live session.

The tabs live in the same server-side UI bag the browsers keep them in (`session-ui.json`, keyed by
conversation), so the new tab reaches **every** device the session is open on and survives a reopen
— not just the browser that happens to be in front of you. What the call deliberately does *not* do
is take over the pane: a browser on the Terminal view keeps it, with the tab waiting in the bar,
while one already showing Files/Split/a file follows to the newly opened file. Which surface is on
screen belongs to the person looking at it; the open tabs are shared state.

Fifty tabs is the ceiling for one session (the panel itself has none — a person closes tabs, and
this endpoint can be called in a loop); past it the oldest give way.

## Opening a pull request in a session's tab bar from inside it (API)

The same again for reviews: `POST /api/self/open-pr` opens a GitHub pull request as a tab in the
calling session's tab bar — the tab the PR picker would have made — with the same three
environment variables and nothing else. Name it by `repo` and `number`, or by its `url` (the one
`gh pr create` prints):

```bash
curl -s -X POST "$CLAUDEWEB_URL/api/self/open-pr" \
  -H "X-Session-Id: $CLAUDEWEB_SESSION_ID" \
  -H "X-Hook-Token: $CLAUDEWEB_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo":"cli/cli","number":42}'
# {"id":"664d6618…","repo":"cli/cli","number":42,"title":"…","key":"cli/cli#42"}
```

Leave `repo` out for the session folder's own repo (its `origin` remote). Any repo `gh` can read
works — it doesn't have to be one of the repos linked to the session. GitHub is asked for the
title before the tab is made, so a wrong number or repo comes back as an error instead of a tab
that can only show one.

Responses are `200` with what opened, `400` with an `error` when the PR can't be named or read (no
number, a malformed repo or URL, a folder that isn't a GitHub repo and no `repo` given, or `gh`'s
own answer — no such PR, not signed in, offline), `401` on missing/stale headers, and `404` when
the id names no live session.

The tab goes into the shared UI bag like the picker's, so it reaches every device, and a PR that
is already open is the same tab, not a second one, with its title refreshed. A *new* tab arrives
active: a browser with the session open shows it, in the group already showing a review if there
is one. Re-opening one that is already in the bar does not move anyone's view. Eight reviews is the
ceiling, as in the picker; past it the oldest gives way, along with its folds and scroll position.

## Security notes

- Auth is a single shared password that mints an in-memory bearer token. The password is stored
  only as a salted PBKDF2 hash in `%LocalAppData%\ClaudeWeb\auth.json` — no plaintext in config
  once you clear `Auth:Password` after first launch. Serve over your trusted LAN; put it behind a
  reverse proxy with TLS if you expose it more widely.
- Launched sessions run in Claude's normal permission mode — you approve actions from the app.

## Layout

```
server/   .NET 10 daemon, the Minimal API host (Program.cs, Sessions/, Auth/, FileSystem/, Diagnostics/, Logging/, Update/)
tray/     Windows tray icon — a client of the daemon's API (WinForms)
ptyhost/  the per-session pty host that owns each pseudoconsole
shared/   source compiled into two projects: Pty/ (daemon ↔ pty host), Contract/ (daemon ↔ tray)
web/      React + Vite + TS + Tailwind + shadcn/ui launcher UI
scripts/  dev.ps1, run.ps1, build.ps1, register-autostart.ps1, install-service.ps1, uninstall-service.ps1,
          stage-update.ps1 + apply-update.ps1 (the two halves of the in-app updater)
```
