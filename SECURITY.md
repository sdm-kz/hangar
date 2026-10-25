# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/sdm-kz/hangar/security/advisories/new)
rather than in a public issue. Include what you found, how to reproduce it and which version
(commit) you tested. You should get a reply within a week.

## What Hangar is, security-wise

Hangar starts Claude Code processes, terminals and a file browser on the machine it runs on, as the
user it runs as. **Anyone who can log in to Hangar can do anything that user can do.** Treat its
password like that user's password.

The defaults are chosen for a single person on their own machine:

- It listens on `127.0.0.1:5099` only.
- With no password set, it answers only requests made on that machine: loopback connections with a
  loopback `Host`, no proxy forwarding headers and no foreign `Origin`. Everything else gets a 403.
- Set `Auth:Password` before you expose it on a network (`Server:Urls`, a reverse proxy, a tunnel).
  The password is hashed into the data folder on first start; remove the plaintext afterwards.
- Logins and node pairing are rate-limited per client, and login tokens expire after 30 days.

Behind a reverse proxy, always set a password: a proxy that adds no forwarding headers cannot be
told apart from a local request. Use HTTPS for anything beyond your own machine.

## Known limitations

These are deliberate trade-offs of a single-user tool, not bugs, but you should know about them
before you expose Hangar beyond your own machine:

- Logged-in users can read and write any file the Hangar user can, and start sessions in any folder.
  There is no per-folder confinement.
- Any logged-in caller (including the external API key) can start a session with
  `bypassPermissions`. The first such session sets `skipDangerousModePermissionPrompt` in
  `~/.claude/settings.json`, which affects every Claude Code session of that user.
- Session folders are added to Claude Code's trusted folders automatically
  (`Sessions:AutoTrustFolders`, on by default).
- The login token is accepted in the `access_token` query parameter, because WebSocket handshakes
  and some file URLs cannot carry a header. It can therefore appear in proxy logs.
- There is no limit on the number of sessions a logged-in user can start.
- `claude` is found through `PATH` unless `Sessions:ClaudeExecutable` is an absolute path.
