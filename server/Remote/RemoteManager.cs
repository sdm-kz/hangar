using System.Collections.Concurrent;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using Renci.SshNet;
using Renci.SshNet.Common;
using Renci.SshNet.Sftp;
using SshNet.Agent;
using ConnectionInfo = Renci.SshNet.ConnectionInfo;

namespace ClaudeWeb.Server.Remote;

/// <summary>Connect a remote files tab. The secrets are used for this connection and kept in memory only.</summary>
public sealed record RemoteConnectRequest(
    RemoteConnection? Connection,
    string? Password = null,
    string? Passphrase = null,
    /// <summary>A host key fingerprint the person has just looked at and accepted.</summary>
    string? TrustFingerprint = null);

/// <summary>
/// How a connect went. <c>Status</c> is one of: "connected"; "hostKey" (an unknown or changed key —
/// show <c>Fingerprint</c> and ask); "secret" (a password or passphrase is needed, or was wrong —
/// <c>Secret</c> says which); "error".
/// </summary>
public sealed record RemoteConnectResult(
    string Status,
    string? Error = null,
    string? Home = null,
    string? Target = null,
    string? Fingerprint = null,
    string? KeyType = null,
    bool Changed = false,
    string? Secret = null,
    /// <summary>An unknown key, from a host that has a trusted key of another type.</summary>
    bool OtherTypeKnown = false);

public sealed record RemoteStatus(bool Connected, string? Home = null, string? Target = null, string? Error = null);

public sealed record RemoteEntry(string Name, string Path, bool IsDir, long Size, DateTime? Modified, bool IsLink);

public sealed record RemoteListing(string Path, string? Parent, IReadOnlyList<RemoteEntry> Entries);

/// <summary>A remote operation that failed for a reason worth showing as it is.</summary>
public sealed class RemoteException(string message) : Exception(message);

/// <summary>The tab has no live connection and cannot get one back without asking the person.</summary>
public sealed class RemoteNotConnectedException(string message) : Exception(message);

/// <summary>
/// The live SSH connections behind the remote files tabs, keyed by the tab's own id. The tab itself
/// — which connection it is, where it was left — lives in the session's UI bag like a pinned page; the
/// connection lives here, in memory, with the password or passphrase it took to open it, so that a
/// dropped link (a laptop asleep, an idle timeout on the far side) comes back on the next request
/// without asking again. Nothing secret is ever written to disk: after a restart of the app the tab
/// finds nothing here and asks — or, for an agent or an unencrypted key, just reconnects.
///
/// <para>Each tab holds one SFTP channel for everything a file panel does, and opens a second
/// connection for a shell command only when it copies within the host (<c>cp -a</c> is far faster
/// than streaming every byte down and back up). A host that offers SFTP but no shell still works:
/// the copy falls back to streaming.</para>
/// </summary>
public sealed class RemoteManager : IDisposable
{
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(15);
    // Unused this long, the connection is closed; the tab keeps its secrets and reopens on next use.
    private static readonly TimeSpan IdleDisconnect = TimeSpan.FromMinutes(30);
    // Unused this long, the tab is forgotten, secrets and all — the browser that held it is gone.
    private static readonly TimeSpan IdleForget = TimeSpan.FromHours(24);
    private const int MaxTabs = 100;

    private readonly KnownHostStore _known;
    private readonly ILogger<RemoteManager> _log;
    private readonly ConcurrentDictionary<string, Tab> _tabs = new(StringComparer.Ordinal);
    // Taken while a connect swaps its new tab in, so two connects for one tab id cannot leave the
    // loser's connection open and unreachable.
    private readonly object _swap = new();
    private readonly Timer _sweep;

    public RemoteManager(KnownHostStore known, ILogger<RemoteManager> log)
    {
        _known = known;
        _log = log;
        _sweep = new Timer(_ => Sweep(), null, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5));
    }

    private sealed record Target(string Host, int Port, string User, string Auth, IReadOnlyList<string> KeyFiles, bool KeysExplicit)
    {
        public string Display => $"{User}@{Host}{(Port == 22 ? "" : $":{Port}")}";
        /// <summary>The filesystem this target reaches, whichever tab reaches it.</summary>
        public string Identity => $"ssh:{User}@{Host.ToLowerInvariant()}:{Port}";
    }

    private sealed class Tab(RemoteConnection spec, Target target, string? password, string? passphrase) : IDisposable
    {
        public readonly RemoteConnection Spec = spec;
        public readonly Target Target = target;
        public readonly string? Password = password;
        public readonly string? Passphrase = passphrase;
        public readonly object Gate = new();
        public SftpClient? Sftp;
        public SshClient? Ssh;
        public bool ExecFailed;
        public string Home = "/";
        public DateTime LastUsed = DateTime.UtcNow;
        /// <summary>Operations running on it — a download, a paste — which the idle sweep must not cut.</summary>
        public int InFlight;
        /// <summary>Closed for good: removed, replaced or forgotten. Nothing may reconnect it.</summary>
        public volatile bool Disposed;

        public void Disconnect()
        {
            lock (Gate)
            {
                try { Sftp?.Dispose(); } catch { /* already gone */ }
                try { Ssh?.Dispose(); } catch { /* already gone */ }
                Sftp = null;
                Ssh = null;
            }
        }

        public void Dispose()
        {
            Disposed = true;
            Disconnect();
        }
    }

    public static bool ValidTabId(string? id) =>
        !string.IsNullOrEmpty(id) && id.Length <= 64 && id.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    // ---- Connecting ---------------------------------------------------------------------------------

    public async Task<RemoteConnectResult> ConnectAsync(string tabId, RemoteConnectRequest req, CancellationToken ct)
    {
        if (!ValidTabId(tabId)) return new("error", "invalid tab id");
        if (req.Connection is null || string.IsNullOrWhiteSpace(req.Connection.Host))
            return new("error", "no host to connect to");
        if (!_tabs.ContainsKey(tabId) && _tabs.Count >= MaxTabs) return new("error", "too many open remote tabs");

        Target target;
        try { target = Resolve(req.Connection); }
        catch (Exception ex) { return new("error", ex.Message); }

        var password = string.IsNullOrEmpty(req.Password) ? null : req.Password;
        var passphrase = string.IsNullOrEmpty(req.Passphrase) ? null : req.Passphrase;
        var tab = new Tab(req.Connection, target, password, passphrase);

        var (info, needs) = BuildConnectionInfo(target, password, passphrase);
        if (needs is not null) return needs with { Target = target.Display };

        var client = new SftpClient(info!) { KeepAliveInterval = TimeSpan.FromSeconds(30) };
        var prompt = WatchHostKey(client, target, req.TrustFingerprint);
        try
        {
            await client.ConnectAsync(ct);
        }
        catch (Exception ex)
        {
            client.Dispose();
            if (prompt.Fingerprint is not null && !prompt.Accepted)
                return new("hostKey", Target: target.Display, Fingerprint: prompt.Fingerprint, KeyType: prompt.KeyType,
                    Changed: prompt.Changed, OtherTypeKnown: prompt.OtherTypeKnown);
            return Failure(ex, target);
        }

        tab.Sftp = client;
        tab.Home = SafeHome(client);
        lock (_swap)
        {
            if (_tabs.TryGetValue(tabId, out var old)) old.Dispose();
            _tabs[tabId] = tab;
        }
        _log.LogInformation("Remote tab {Tab} connected to {Target}", tabId, target.Display);
        return new("connected", Home: tab.Home, Target: target.Display);
    }

    /// <summary>Whether the tab is connected — reconnecting it first if it has what that takes.</summary>
    public RemoteStatus Status(string tabId)
    {
        if (!_tabs.TryGetValue(tabId, out var tab)) return new(false);
        try
        {
            Ensure(tab);
            return new(true, tab.Home, tab.Target.Display);
        }
        catch (Exception ex)
        {
            return new(false, Target: tab.Target.Display, Error: ex.Message);
        }
    }

    public void Disconnect(string tabId)
    {
        if (_tabs.TryRemove(tabId, out var tab))
        {
            tab.Dispose();
            _log.LogInformation("Remote tab {Tab} disconnected", tabId);
        }
    }

    /// <summary>
    /// The connection parameters for a target, with its auth methods — or the reason there are none
    /// yet: a password nobody has typed, a key locked behind a passphrase.
    /// </summary>
    private (ConnectionInfo? Info, RemoteConnectResult? Needs) BuildConnectionInfo(Target t, string? password, string? passphrase)
    {
        var methods = new List<AuthenticationMethod>();
        switch (t.Auth)
        {
            case "password":
                if (password is null) return (null, new("secret", Secret: "password"));
                methods.Add(new PasswordAuthenticationMethod(t.User, password));
                // Many servers only take a password through keyboard-interactive (PAM).
                var kbd = new KeyboardInteractiveAuthenticationMethod(t.User);
                kbd.AuthenticationPrompt += (_, e) =>
                {
                    foreach (var p in e.Prompts) p.Response = password;
                };
                methods.Add(kbd);
                break;

            case "key":
            {
                var keys = new List<IPrivateKeySource>();
                var locked = false;
                foreach (var file in t.KeyFiles)
                {
                    try
                    {
                        keys.Add(new PrivateKeyFile(file, passphrase));
                    }
                    catch (SshPassPhraseNullOrEmptyException)
                    {
                        locked = true;
                    }
                    catch (Exception ex) when (passphrase is not null && ex is SshException or ArgumentException or InvalidOperationException)
                    {
                        // A passphrase was given and it did not open this key.
                        if (t.KeysExplicit || t.KeyFiles.Count == 1)
                            return (null, new("secret", "That passphrase does not open the key.", Secret: "passphrase"));
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        if (t.KeysExplicit) return (null, new("error", $"Could not read the key file {file}: {ex.Message}"));
                    }
                    catch (Exception ex)
                    {
                        if (t.KeysExplicit) return (null, new("error", $"Could not load the key file {file}: {ex.Message}"));
                    }
                }
                if (keys.Count == 0)
                {
                    if (locked) return (null, new("secret", Secret: "passphrase"));
                    return (null, new("error", t.KeyFiles.Count == 0
                        ? "No private key found — name one, or put one in ~/.ssh."
                        : "No usable private key."));
                }
                methods.Add(new PrivateKeyAuthenticationMethod(t.User, keys.ToArray()));
                break;
            }

            case "agent":
            {
                var keys = AgentKeys(out var why);
                if (keys.Length == 0) return (null, new("error", why));
                methods.Add(new PrivateKeyAuthenticationMethod(t.User, keys));
                break;
            }

            default:
                return (null, new("error", $"unknown auth method '{t.Auth}'"));
        }
        return (new ConnectionInfo(t.Host, t.Port, t.User, methods.ToArray()) { Timeout = ConnectTimeout }, null);
    }

    /// <summary>The identities the running agent holds: OpenSSH's first, then Pageant's on Windows.</summary>
    private static IPrivateKeySource[] AgentKeys(out string why)
    {
        why = "No SSH agent is running, or it holds no keys. Start the OpenSSH Authentication Agent " +
              "service (or Pageant) and add a key with ssh-add.";
        try
        {
            var keys = new SshAgent().RequestIdentities();
            if (keys.Length > 0) return keys.Cast<IPrivateKeySource>().ToArray();
        }
        catch { /* not running — try Pageant */ }
        if (OperatingSystem.IsWindows())
        {
            try
            {
                var keys = new Pageant().RequestIdentities();
                if (keys.Length > 0) return keys.Cast<IPrivateKeySource>().ToArray();
            }
            catch { /* not running either */ }
        }
        return [];
    }

    private sealed class HostKeyPrompt
    {
        public string? Fingerprint;
        public string? KeyType;
        public bool Changed;
        public bool OtherTypeKnown;
        public bool Accepted;
    }

    /// <summary>
    /// Trust on first use. A key this store knows passes; an unknown or changed one is refused unless
    /// it is exactly the fingerprint the person was just shown and accepted — which is the one moment
    /// it is written down.
    /// </summary>
    private HostKeyPrompt WatchHostKey(BaseClient client, Target t, string? trustFingerprint)
    {
        var prompt = new HostKeyPrompt();
        client.HostKeyReceived += (_, e) =>
        {
            var fp = "SHA256:" + e.FingerPrintSHA256;
            prompt.Fingerprint = fp;
            prompt.KeyType = e.HostKeyName;
            var verdict = _known.Check(t.Host, t.Port, e.HostKeyName, fp);
            prompt.Changed = verdict == HostKeyVerdict.Changed;
            prompt.OtherTypeKnown = verdict == HostKeyVerdict.Unknown && _known.KnowsOtherType(t.Host, t.Port, e.HostKeyName);
            if (verdict == HostKeyVerdict.Known)
            {
                prompt.Accepted = true;
                e.CanTrust = true;
                return;
            }
            if (!string.IsNullOrEmpty(trustFingerprint) && trustFingerprint == fp)
            {
                _known.Trust(t.Host, t.Port, e.HostKeyName, fp);
                _log.LogInformation("Trusted the {Type} host key {Fingerprint} of {Host}:{Port}", e.HostKeyName, fp, t.Host, t.Port);
                prompt.Accepted = true;
                e.CanTrust = true;
                return;
            }
            e.CanTrust = false;
        };
        return prompt;
    }

    private static RemoteConnectResult Failure(Exception ex, Target t)
    {
        var target = t.Display;
        return ex switch
        {
            SshAuthenticationException when t.Auth == "password" =>
                new("secret", "Permission denied — check the user name and password.", Target: target, Secret: "password"),
            SshAuthenticationException when t.Auth == "agent" =>
                new("error", "Permission denied — none of the agent's keys were accepted.", Target: target),
            SshAuthenticationException =>
                new("error", "Permission denied — the key was not accepted.", Target: target),
            SocketException se => new("error", se.SocketErrorCode switch
            {
                SocketError.HostNotFound or SocketError.NoData => $"Unknown host {t.Host}.",
                SocketError.ConnectionRefused => $"{t.Host} refused the connection on port {t.Port}.",
                SocketError.TimedOut => $"{t.Host} did not answer.",
                _ => se.Message,
            }, Target: target),
            SshOperationTimeoutException => new("error", $"{t.Host} did not answer in time.", Target: target),
            OperationCanceledException => new("error", "Cancelled.", Target: target),
            _ => new("error", ex.Message, Target: target),
        };
    }

    /// <summary>The connection's parameters with the config filled in: alias, user, port, key files.</summary>
    private static Target Resolve(RemoteConnection c)
    {
        var host = c.Host.Trim();
        var user = string.IsNullOrWhiteSpace(c.User) ? null : c.User.Trim();
        // "user@host" typed into the host field is what anyone who uses ssh will do.
        var at = host.LastIndexOf('@');
        if (at > 0)
        {
            user ??= host[..at];
            host = host[(at + 1)..];
        }
        var port = c.Port;
        // "host:2222" likewise — but not an IPv6 literal, which is full of colons.
        var m = Regex.Match(host, @"^([^:\[\]]+):(\d{1,5})$");
        if (m.Success)
        {
            host = m.Groups[1].Value;
            if (port <= 0) port = int.Parse(m.Groups[2].Value);
        }
        host = host.Trim('[', ']');

        var cfg = SshConfigFile.Resolve(host);
        var realHost = cfg.HostName ?? host;
        if (port <= 0) port = cfg.Port ?? 22;
        if (port > 65535) throw new RemoteException($"Port {port} is out of range.");
        user ??= cfg.User ?? Environment.UserName;

        var auth = c.Auth is "key" or "agent" ? c.Auth : "password";
        IReadOnlyList<string> keys = [];
        var explicitKeys = false;
        if (auth == "key")
        {
            if (!string.IsNullOrWhiteSpace(c.KeyPath))
            {
                keys = [SshConfigFile.ExpandPath(c.KeyPath, realHost, user)];
                explicitKeys = true;
            }
            else if (cfg.IdentityFile is not null)
            {
                keys = [cfg.IdentityFile];
                explicitKeys = true;
            }
            else keys = SshConfigFile.DefaultKeys();
        }
        return new Target(realHost, port, user, auth, keys, explicitKeys);
    }

    private static string SafeHome(SftpClient client)
    {
        try { return string.IsNullOrEmpty(client.WorkingDirectory) ? "/" : client.WorkingDirectory; }
        catch { return "/"; }
    }

    /// <summary>
    /// Make sure the tab's SFTP channel is up, reopening it with what the tab already holds. Throws
    /// <see cref="RemoteNotConnectedException"/> when that is not enough: no tab at all (the app
    /// restarted), or a host key that is no longer the one that was trusted.
    /// </summary>
    private SftpClient Ensure(Tab tab)
    {
        lock (tab.Gate)
        {
            if (tab.Disposed) throw new RemoteNotConnectedException("Not connected.");
            tab.LastUsed = DateTime.UtcNow;
            if (tab.Sftp is { IsConnected: true } live) return live;
            try { tab.Sftp?.Dispose(); } catch { /* already gone */ }
            tab.Sftp = null;

            var (info, needs) = BuildConnectionInfo(tab.Target, tab.Password, tab.Passphrase);
            if (needs is not null) throw new RemoteNotConnectedException(needs.Error ?? "Credentials needed.");
            var client = new SftpClient(info!) { KeepAliveInterval = TimeSpan.FromSeconds(30) };
            var prompt = WatchHostKey(client, tab.Target, null);
            try
            {
                client.Connect();
            }
            catch (Exception ex)
            {
                client.Dispose();
                if (prompt.Fingerprint is not null && !prompt.Accepted)
                    throw new RemoteNotConnectedException(prompt.Changed
                        ? "The host key has changed since it was trusted."
                        : "The host key is not trusted.");
                throw new RemoteNotConnectedException(Failure(ex, tab.Target).Error ?? ex.Message);
            }
            tab.Sftp = client;
            tab.Home = SafeHome(client);
            return client;
        }
    }

    /// <summary>A second connection for shell commands, opened on first use; null when the host has none.</summary>
    private SshClient? Exec(Tab tab)
    {
        lock (tab.Gate)
        {
            if (tab.ExecFailed || tab.Disposed) return null;
            if (tab.Ssh is { IsConnected: true } live) return live;
            try { tab.Ssh?.Dispose(); } catch { /* already gone */ }
            tab.Ssh = null;
            var (info, needs) = BuildConnectionInfo(tab.Target, tab.Password, tab.Passphrase);
            if (needs is not null) return null;
            var client = new SshClient(info!) { KeepAliveInterval = TimeSpan.FromSeconds(30) };
            WatchHostKey(client, tab.Target, null);
            try
            {
                client.Connect();
                tab.Ssh = client;
                return client;
            }
            catch (Exception ex)
            {
                _log.LogDebug(ex, "No shell channel to {Target}; copies will stream", tab.Target.Display);
                client.Dispose();
                tab.ExecFailed = true;
                return null;
            }
        }
    }

    private Tab Get(string tabId) =>
        _tabs.TryGetValue(tabId, out var tab)
            ? tab
            : throw new RemoteNotConnectedException("Not connected.");

    /// <summary>
    /// Run one operation on the tab's SFTP channel, mapping what SFTP throws to errors worth showing.
    /// A connection that died under the call is reopened and the call made once more.
    /// </summary>
    /// <param name="retry">
    /// Whether the call may be made again on a fresh connection. Off for anything that consumes its
    /// input (an upload's stream) — a second go would write only what was left of it.
    /// </param>
    private T Run<T>(string tabId, Func<SftpClient, Tab, T> op, bool retry = true)
    {
        var tab = Get(tabId);
        Interlocked.Increment(ref tab.InFlight);
        try
        {
            for (var attempt = 0; ; attempt++)
            {
                var sftp = Ensure(tab);
                try
                {
                    return op(sftp, tab);
                }
                catch (Exception ex) when (retry && attempt == 0 && !tab.Disposed
                                           && (ex is SshConnectionException or ObjectDisposedException
                                               || (ex is SshException && !sftp.IsConnected)))
                {
                    // Only the client that failed: another request may already have opened a new one.
                    DropClient(tab, sftp);
                }
                catch (Renci.SshNet.Common.SftpPathNotFoundException)
                {
                    throw new RemoteException("No such file or folder.");
                }
                catch (Renci.SshNet.Common.SftpPermissionDeniedException)
                {
                    throw new RemoteException("Permission denied.");
                }
                catch (Exception ex) when (tab.Disposed && ex is SshConnectionException or ObjectDisposedException)
                {
                    throw new RemoteNotConnectedException("Not connected.");
                }
            }
        }
        finally
        {
            tab.LastUsed = DateTime.UtcNow;
            Interlocked.Decrement(ref tab.InFlight);
        }
    }

    private static void DropClient(Tab tab, SftpClient failed)
    {
        lock (tab.Gate)
        {
            if (!ReferenceEquals(tab.Sftp, failed)) return;
            try { failed.Dispose(); } catch { /* already gone */ }
            tab.Sftp = null;
        }
    }

    /// <summary>
    /// Hold a tab busy for an operation that outlives one call — a download being streamed, a paste
    /// running — so the idle sweep leaves its connection alone. Dispose to let go.
    /// </summary>
    internal IDisposable Hold(string tabId)
    {
        var tab = Get(tabId);
        Interlocked.Increment(ref tab.InFlight);
        return new Release(() =>
        {
            tab.LastUsed = DateTime.UtcNow;
            Interlocked.Decrement(ref tab.InFlight);
        });
    }

    private sealed class Release(Action release) : IDisposable
    {
        private int _done;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _done, 1) == 0) release();
        }
    }

    /// <summary>
    /// The entry for <paramref name="path"/> as its folder lists it, attributes and all. Unlike
    /// <see cref="SftpClient.Get"/> — which asks the server for the real path first, and so describes
    /// what a symbolic link points at — this is the link itself: deleting or renaming it acts on the
    /// link, never on its target.
    /// </summary>
    internal static ISftpFile Entry(SftpClient sftp, string path)
    {
        var name = NameOf(path);
        return sftp.ListDirectory(Parent(path)).FirstOrDefault(f => f.Name == name)
               ?? throw new RemoteException("No such file or folder.");
    }

    // ---- Paths ---------------------------------------------------------------------------------------

    /// <summary>
    /// Whether a host speaks Windows paths, judged by a path it gave us: Windows' OpenSSH server
    /// spells "C:\Users\x" as "/C:/Users/x".
    /// </summary>
    public static bool IsWindowsPath(string path) => Regex.IsMatch(path, "^/[A-Za-z]:(/|$)");

    /// <summary>
    /// An absolute POSIX path with "." and ".." folded away. A relative one is taken against the
    /// remote home, and "~" is the home itself — both what someone typing a path expects.
    ///
    /// <para>On a Windows host (see <see cref="IsWindowsPath"/>) a path is often typed the Windows
    /// way — "c:\logs" — and is turned into the server's own spelling, "/C:/logs", rather than taken
    /// as a relative name. A bare drive keeps its slash: "/C:/" is the drive's root, "/C:" is not a
    /// folder the server will list.</para>
    /// </summary>
    public static string Normalize(string? path, string home)
    {
        var p = string.IsNullOrWhiteSpace(path) ? home : path.Trim();
        var windows = IsWindowsPath(home);
        if (windows)
        {
            p = p.Replace('\\', '/');
            if (Regex.IsMatch(p, "^[A-Za-z]:(/|$)")) p = "/" + char.ToUpperInvariant(p[0]) + p[1..];
        }
        if (p == "~") p = home;
        else if (p.StartsWith("~/")) p = home.TrimEnd('/') + p[1..];
        if (!p.StartsWith('/')) p = home.TrimEnd('/') + "/" + p;
        var parts = new List<string>();
        foreach (var seg in p.Split('/'))
        {
            if (seg.Length == 0 || seg == ".") continue;
            if (seg == "..")
            {
                if (parts.Count > 0) parts.RemoveAt(parts.Count - 1);
                continue;
            }
            parts.Add(seg);
        }
        return DriveRoot("/" + string.Join('/', parts));
    }

    public static string Parent(string path)
    {
        var i = path.TrimEnd('/').LastIndexOf('/');
        return i <= 0 ? "/" : DriveRoot(path[..i]);
    }

    /// <summary>"/C:" → "/C:/": the form of a Windows drive's root its SFTP server lists.</summary>
    private static string DriveRoot(string path) => Regex.IsMatch(path, "^/[A-Za-z]:$") ? path + "/" : path;

    public static string NameOf(string path)
    {
        var t = path.TrimEnd('/');
        return t.Length == 0 ? "/" : t[(t.LastIndexOf('/') + 1)..];
    }

    public static string Join(string dir, string name) => dir.TrimEnd('/') + "/" + name;

    private static string CleanName(string? name)
    {
        var n = (name ?? "").Trim();
        if (n.Length == 0 || n == "." || n == ".." || n.Contains('/') || n.Contains('\0'))
            throw new RemoteException("That is not a valid name.");
        return n;
    }

    /// <summary>A name in <paramref name="dir"/> nothing is using yet: "a.txt", then "a (1).txt", …</summary>
    internal static string Unique(SftpClient sftp, string dir, string name)
    {
        var target = Join(dir, name);
        if (!sftp.Exists(target)) return target;
        var dot = name.LastIndexOf('.');
        var (stem, ext) = dot > 0 ? (name[..dot], name[dot..]) : (name, "");
        for (var i = 1; ; i++)
        {
            target = Join(dir, $"{stem} ({i}){ext}");
            if (!sftp.Exists(target)) return target;
        }
    }

    // ---- Operations ----------------------------------------------------------------------------------

    public RemoteListing List(string tabId, string? path) => Run(tabId, (sftp, tab) =>
    {
        var dir = Normalize(path, tab.Home);
        var entries = new List<RemoteEntry>();
        foreach (var f in sftp.ListDirectory(dir))
        {
            if (f.Name is "." or "..") continue;
            var isDir = f.IsDirectory;
            long size = f.Length;
            if (f.IsSymbolicLink)
            {
                // A link is drawn as what it points at, so a linked folder opens like one.
                try
                {
                    var a = sftp.GetAttributes(f.FullName);
                    isDir = a.IsDirectory;
                    size = a.Size;
                }
                catch { /* dangling — show it as a file */ }
            }
            entries.Add(new RemoteEntry(f.Name, Join(dir, f.Name), isDir, isDir ? 0 : size, f.LastWriteTimeUtc, f.IsSymbolicLink));
        }
        entries.Sort((a, b) => a.IsDir != b.IsDir
            ? (a.IsDir ? -1 : 1)
            : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return new RemoteListing(dir, dir == "/" ? null : Parent(dir), entries);
    });

    /// <summary>A file opened for reading, with its length. The caller disposes the stream.</summary>
    public (Stream Stream, long Length, string Name) OpenRead(string tabId, string path) => Run(tabId, (sftp, tab) =>
    {
        var full = Normalize(path, tab.Home);
        var attrs = sftp.GetAttributes(full);
        if (attrs.IsDirectory) throw new RemoteException("That is a folder.");
        Stream s = sftp.Open(full, FileMode.Open, FileAccess.Read);
        return (s, attrs.Size, NameOf(full));
    });

    public void WriteText(string tabId, string path, string content) => Run(tabId, (sftp, tab) =>
    {
        var full = Normalize(path, tab.Home);
        using var ms = new MemoryStream(new UTF8Encoding(false).GetBytes(content));
        sftp.UploadFile(ms, full, canOverride: true);
        return true;
    });

    public string Mkdir(string tabId, string path) => Run(tabId, (sftp, tab) =>
    {
        var full = Normalize(path, tab.Home);
        CleanName(NameOf(full));
        if (sftp.Exists(full)) throw new RemoteException("Something with that name is already there.");
        sftp.CreateDirectory(full);
        return full;
    });

    public string NewFile(string tabId, string path) => Run(tabId, (sftp, tab) =>
    {
        var full = Normalize(path, tab.Home);
        CleanName(NameOf(full));
        if (sftp.Exists(full)) throw new RemoteException("Something with that name is already there.");
        using (sftp.Create(full)) { }
        return full;
    });

    public string Rename(string tabId, string path, string newName) => Run(tabId, (sftp, tab) =>
    {
        var full = Normalize(path, tab.Home);
        if (full == "/") throw new RemoteException("The root cannot be renamed.");
        var target = Join(Parent(full), CleanName(newName));
        if (target == full) return full;
        if (sftp.Exists(target)) throw new RemoteException("Something with that name is already there.");
        Entry(sftp, full).MoveTo(target);
        return target;
    });

    public void Delete(string tabId, string path) => Run(tabId, (sftp, tab) =>
    {
        var full = Normalize(path, tab.Home);
        if (full == "/") throw new RemoteException("The root cannot be deleted.");
        DeleteTree(sftp, full, 0);
        return true;
    });

    internal static void DeleteTree(SftpClient sftp, string path, int depth) => DeleteTree(sftp, Entry(sftp, path), depth);

    /// <summary>
    /// Delete an entry as its folder listed it. A listing's attributes describe a symbolic link as a
    /// link (it is not a directory), and <see cref="ISftpFile.Delete"/> removes it by its own name, so
    /// a link to a folder goes as the link — the folder it points at is never walked into.
    /// </summary>
    private static void DeleteTree(SftpClient sftp, ISftpFile entry, int depth)
    {
        if (depth > 64) throw new RemoteException("Folder nesting is too deep.");
        if (entry.IsDirectory && !entry.IsSymbolicLink)
            foreach (var child in sftp.ListDirectory(entry.FullName))
                if (child.Name is not "." and not "..")
                    DeleteTree(sftp, child, depth + 1);
        entry.Delete();
    }

    public string Upload(string tabId, string folder, string fileName, Stream content) => Run(tabId, (sftp, tab) =>
    {
        var dir = Normalize(folder, tab.Home);
        // Whatever path the browser sent along, only the name is used.
        var name = CleanName(fileName.Split('/', '\\').LastOrDefault());
        var target = Unique(sftp, dir, name);
        try
        {
            sftp.UploadFile(content, target, canOverride: false);
        }
        catch
        {
            // Half a file under the name asked for is worse than none.
            try { sftp.DeleteFile(target); } catch { /* the link is gone too */ }
            throw;
        }
        return target;
    }, retry: false);

    /// <summary>The SFTP side of a tab, for <see cref="FileTransfer"/>; connected, or it throws.</summary>
    internal IFileSide Side(string tabId)
    {
        var tab = Get(tabId);
        var sftp = Ensure(tab);
        return new RemoteSide(tabId, tab.Target.Identity, sftp, tab.Home, () => Exec(tab));
    }

    // ---- Housekeeping --------------------------------------------------------------------------------

    private void Sweep()
    {
        var now = DateTime.UtcNow;
        foreach (var (id, tab) in _tabs)
        {
            var idle = now - tab.LastUsed;
            if (idle > IdleForget && Volatile.Read(ref tab.InFlight) == 0)
            {
                if (_tabs.TryRemove(id, out var gone)) gone.Dispose();
            }
            else if (idle > IdleDisconnect && Volatile.Read(ref tab.InFlight) == 0 && (tab.Sftp is not null || tab.Ssh is not null))
            {
                tab.Disconnect();
            }
        }
    }

    public void Dispose()
    {
        _sweep.Dispose();
        foreach (var tab in _tabs.Values) tab.Dispose();
        _tabs.Clear();
    }
}
