using System.Collections.Concurrent;
using System.Text.Json;
using ClaudeWeb.Pty;
using ClaudeWeb.Server.Sessions.Pty;

namespace ClaudeWeb.Server.Sessions.Shells;

/// <summary>Request to open a shell tab.</summary>
public sealed record CreateShellRequest(
    /// <summary>The session the tab belongs to; null for a shell opened from the server Files tree.</summary>
    string? SessionId,
    /// <summary>Folder the shell starts in. Must exist.</summary>
    string WorkingDirectory,
    /// <summary>Which shell (see <see cref="ShellOption.Id"/>); null takes <see cref="ShellCatalog.DefaultId"/>.</summary>
    string? Shell = null);

/// <summary>A shell tab as the browser sees it.</summary>
public sealed record ShellInfo(
    string Id,
    string? SessionId,
    string WorkingDirectory,
    /// <summary><see cref="ShellOption.Id"/> this was launched with.</summary>
    string Shell,
    /// <summary>Label and family of that shell at launch time, kept so a tab still names itself
    /// after the shell is uninstalled (or the machine it was adopted from had a different set).</summary>
    string Label,
    string Kind,
    int ProcessId,
    DateTimeOffset CreatedAt,
    /// <summary>False once the shell process has ended — the tab stays until it is closed.</summary>
    bool Running);

/// <summary>
/// Shell tabs: a plain interactive shell (cmd, PowerShell, Git Bash, a WSL distribution) attached to
/// a pseudoconsole in a session's working folder, streamed to the browser through the same
/// <see cref="TerminalSocket"/> the Claude terminal uses.
/// </summary>
/// <remarks>
/// <para>The machinery underneath is the session one, deliberately: a shell gets its own
/// <c>ClaudeWeb.PtyHost.exe</c> from a <see cref="PtyHostLauncher"/>, so a shell with a build running
/// in it <b>survives a restart of this app</b> exactly as a session does, and comes back with its
/// scrollback on the next start.</para>
/// <para>What it does <em>not</em> share is the launcher's instance key: shells run under
/// <c>&lt;instance&gt;-sh</c>, which puts their state files in their own directory. That is what keeps
/// <see cref="SessionManager.ListOrphans"/> from reporting every shell as an orphaned Claude session
/// and offering to stop it — the two sets must not see each other.</para>
/// </remarks>
public sealed class ShellManager : IDisposable
{
    /// <summary>Cap on live shells, so a runaway client can't spawn hosts without bound.</summary>
    private const int MaxShells = 64;

    private readonly PtyHostLauncher _hosts;
    private readonly ILogger<ShellManager> _log;
    private readonly string _stateFile;
    private readonly object _saveLock = new();
    private readonly ConcurrentDictionary<string, Shell> _shells = new();
    // Shells whose host is alive but which we could not attach to at startup (a pipe that timed out,
    // a protocol the host predates). Their metadata is written back out untouched so the next start
    // can name them again: dropping it would leave a live host that no session claims, no UI lists,
    // and nothing can close.
    private IReadOnlyList<PersistedShell> _unadopted = [];
    // Spawns in flight. StartAsync can take StartTimeoutMs, so without counting these the cap below
    // is a check against a number that is always stale: N simultaneous requests would all pass it.
    private int _starting;

    /// <summary>Raised when the shell set changes, so a live view can re-read it.</summary>
    public event Action? Changed;

    private int _revision;

    /// <summary>
    /// Bumped on every change to the shell set. It rides the session hub's snapshot so a browser can
    /// tell its list is stale and re-fetch — the shells themselves don't need to be broadcast to
    /// everyone on every tick, and a browser that isn't looking at that session doesn't care.
    /// </summary>
    public int Revision => Volatile.Read(ref _revision);

    private void RaiseChanged()
    {
        Interlocked.Increment(ref _revision);
        Changed?.Invoke();
    }

    public ShellManager(PtyHostOptions ptyHost, ILoggerFactory loggerFactory)
    {
        _log = loggerFactory.CreateLogger<ShellManager>();
        // Same options, own namespace — see the class remarks.
        _hosts = new PtyHostLauncher(
            new PtyHostOptions
            {
                InstanceKey = (string.IsNullOrWhiteSpace(ptyHost.InstanceKey) ? "default" : ptyHost.InstanceKey) + "-sh",
                HostExecutable = ptyHost.HostExecutable,
                AttachTimeoutMs = ptyHost.AttachTimeoutMs,
                StartTimeoutMs = ptyHost.StartTimeoutMs,
            },
            loggerFactory.CreateLogger<PtyHostLauncher>());
        // Namespaced by instance for the same reason the pty state directory is: the ClaudeWeb
        // folder under %LocalAppData% is shared by every instance on the machine, and a dev instance
        // that found none of the live app's hosts (they live under a different key) would otherwise
        // rewrite the file to [] and strand them.
        _stateFile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", $"shells-{_hosts.InstanceKey}.json");
    }

    /// <summary>Every live shell, newest last; optionally only those belonging to one session.</summary>
    public IReadOnlyList<ShellInfo> List(string? sessionId = null) =>
        _shells.Values
            .Where(s => sessionId is null || s.SessionId == sessionId)
            .OrderBy(s => s.CreatedAt)
            .Select(s => s.ToInfo())
            .ToArray();

    public ShellInfo? Get(string id) => _shells.TryGetValue(id, out var s) ? s.ToInfo() : null;

    /// <summary>The live terminal for a shell, for the WebSocket endpoint; null when there's no such shell.</summary>
    public ITerminal? GetTerminal(string id) => _shells.TryGetValue(id, out var s) ? s.Terminal : null;

    /// <summary>
    /// Open a shell: spawn its pty host in the folder and attach. Throws when the folder is gone, the
    /// shell isn't available on this machine, or the host never answers.
    /// </summary>
    public async Task<ShellInfo> CreateAsync(CreateShellRequest req, CancellationToken ct = default)
    {
        var dir = (req.WorkingDirectory ?? "").Trim();
        if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
            throw new DirectoryNotFoundException($"Working directory does not exist: {dir}");
        var fullDir = Path.GetFullPath(dir);

        var wanted = req.Shell is { Length: > 0 } ? req.Shell : ShellCatalog.DefaultId;
        var option = ShellCatalog.Find(wanted)
            ?? throw new InvalidOperationException($"No shell named '{wanted}' is available on this machine.");

        // Only live shells count: a tab left open on a shell someone exited by typing `exit` is a
        // scrollback to read, not a process, and it must not push anyone into this ceiling.
        if (Interlocked.Increment(ref _starting) + _shells.Values.Count(s => s.Running) > MaxShells)
        {
            Interlocked.Decrement(ref _starting);
            throw new InvalidOperationException($"Too many shells are open ({MaxShells}); close one first.");
        }

        try
        {
            var launch = ShellCatalog.LaunchFor(option, fullDir);
            var id = "sh-" + Guid.NewGuid().ToString("n")[..12];

            _log.LogInformation("Opening {Shell} shell {Id} in {Cwd}: {Exe} {Args}",
                option.Id, id, fullDir, launch.FileName, string.Join(' ', launch.Arguments));

            var client = await _hosts.StartAsync(
                id, launch.FileName, launch.Arguments, fullDir, BuildEnvironment(launch), 120, 30,
                // The hang watchdog reads a Claude TUI; against a shell prompt it has nothing to say,
                // so it is spawned switched off rather than left to interpret somebody's build output.
                new WatchdogOptions { Enabled = false }, watchdogEnabled: false,
                verbatimArguments: true, ct: ct);

            var shell = new Shell(id, req.SessionId, fullDir, option.Id, option.Label, option.Kind, DateTimeOffset.Now);
            Bind(shell, client);
            _shells[id] = shell;
            Save();
            RaiseChanged();
            return shell.ToInfo();
        }
        finally { Interlocked.Decrement(ref _starting); }
    }

    /// <summary>Close a shell and kill the process in it. Returns false when the id is unknown.</summary>
    public async Task<bool> CloseAsync(string id, CancellationToken ct = default)
    {
        if (!_shells.TryRemove(id, out var shell)) return false;
        await ShutdownAsync(shell, ct);
        Save();
        RaiseChanged();
        return true;
    }

    /// <summary>Close every shell belonging to a session — used when the session itself is stopped.</summary>
    /// <remarks>
    /// In parallel: each close can spend the shutdown grace waiting on a host that is ignoring it, and
    /// a session with several shells would otherwise hold the DELETE request for the sum of them.
    /// </remarks>
    public Task CloseForSessionAsync(string sessionId, CancellationToken ct = default)
    {
        var mine = _shells.Values.Where(s => s.SessionId == sessionId).Select(s => s.Id).ToArray();
        return Task.WhenAll(mine.Select(id => CloseAsync(id, ct)));
    }

    private async Task ShutdownAsync(Shell shell, CancellationToken ct)
    {
        try
        {
            if (shell.Client is { } client)
            {
                await client.ShutdownAsync(kill: true, ct);
                // Both of these block on Process.WaitForExit for up to a few seconds. This runs
                // under an HTTP request, so it goes to the pool rather than parking the request's
                // own thread on a process that is taking its time.
                await Task.Run(() => _hosts.WaitForHostExit(shell.Id, TimeSpan.FromSeconds(3)), CancellationToken.None);
                client.Dispose();
            }
        }
        catch (Exception ex) { _log.LogDebug(ex, "Shell {Id} did not acknowledge shutdown", shell.Id); }
        // The host's job object takes the shell (and anything it started) down with it; this is the
        // backstop for a host that ignored the polite ask, and it also clears the state file.
        await Task.Run(() => _hosts.KillHost(shell.Id), CancellationToken.None);
        shell.Client = null;
        _log.LogInformation("Closed shell {Id}.", shell.Id);
    }

    /// <summary>
    /// Re-attach to the shells whose pty hosts are still running, and forget the rest. Mirrors
    /// <see cref="SessionManager.AdoptRunningHostsAsync"/>, minus the resume half: a shell whose
    /// process is genuinely gone (the machine rebooted) has nothing worth relaunching — its value was
    /// the scrollback and the state in it, and both died with it.
    /// </summary>
    public async Task AdoptRunningHostsAsync(CancellationToken ct = default)
    {
        var persisted = LoadPersisted();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var unadopted = new List<PersistedShell>();

        foreach (var (path, state) in PtyStateStore.ReadAll(_hosts.InstanceKey))
        {
            if (ct.IsCancellationRequested) return; // mid-adoption: the file still holds the truth
            seen.Add(state.SessionId);
            if (!PtyStateStore.HostAlive(state)) { PtyStateStore.Delete(path); continue; }

            var meta = persisted.FirstOrDefault(p => p.Id == state.SessionId);
            PtyHostClient? client = null;
            try { client = await _hosts.AttachAsync(state.SessionId, state.PipeName, ct); }
            catch (Exception ex) { _log.LogDebug(ex, "Could not re-attach to shell {Id}", state.SessionId); }
            if (client is null)
            {
                // The host is alive and simply didn't answer in time. Keep what we know about it so
                // the next start can try again and still name it, instead of turning a working shell
                // into a process nothing can reach.
                _log.LogWarning(
                    "Shell {Id} (host pid {HostPid}, {Cwd}) did not answer its pipe; leaving it running and remembering it for the next start.",
                    state.SessionId, state.HostPid, state.WorkingDirectory);
                if (meta is not null) unadopted.Add(meta);
                continue;
            }

            // A live host with no metadata is still a working shell (shells.json was lost, or an older
            // build wrote none) — keep it, naming it from what the state file knows.
            var shell = new Shell(
                state.SessionId, meta?.SessionId, meta?.WorkingDirectory ?? state.WorkingDirectory,
                meta?.Shell ?? "cmd", meta?.Label ?? "Shell", meta?.Kind ?? "cmd",
                meta?.CreatedAt ?? state.CreatedAt);
            Bind(shell, client);
            _shells[shell.Id] = shell;
            _log.LogInformation("Re-attached to shell {Id} ({Label}) in {Cwd}: host pid {HostPid}, child pid {Pid}.",
                shell.Id, shell.Label, shell.WorkingDirectory, state.HostPid, client.ProcessId);
        }

        // Entries whose host is gone (a reboot, or a shell someone exited while we were down).
        if (persisted.Any(p => !seen.Contains(p.Id)))
            _log.LogInformation("Dropped {Count} shell(s) whose process did not survive.",
                persisted.Count(p => !seen.Contains(p.Id)));
        _unadopted = unadopted;
        Save();
        if (!_shells.IsEmpty) RaiseChanged();
    }

    /// <summary>Wire a connected client into a shell and follow its process.</summary>
    private void Bind(Shell shell, PtyHostClient client)
    {
        shell.Client = client;
        shell.ProcessId = client.ProcessId;
        shell.Running = !client.AlreadyExited;
        client.Exited += _ =>
        {
            shell.Running = false;
            // The tab stays so the last output can still be read; closing it is the user's call.
            Save();
            RaiseChanged();
        };
    }

    /// <summary>
    /// The environment the shell is launched with: ours (the host is detached and passes on nothing of
    /// its own), plus whatever the shell needs. Deliberately without <c>CLAUDEWEB_HOOK_TOKEN</c> — a
    /// shell is an interactive prompt for the user, not a session reporting its lifecycle back.
    /// </summary>
    private static Dictionary<string, string> BuildEnvironment(ShellLaunch launch)
    {
        var env = new Dictionary<string, string>();
        foreach (System.Collections.DictionaryEntry kv in Environment.GetEnvironmentVariables())
            env[(string)kv.Key] = kv.Value?.ToString() ?? "";
        foreach (var (k, v) in launch.ExtraEnvironment) env[k] = v;
        return env;
    }

    // ---- Persistence ----------------------------------------------------------------------------

    /// <summary>What a shell needs to be named again after a restart; the pty state file has the rest.</summary>
    private sealed record PersistedShell(
        string Id, string? SessionId, string WorkingDirectory, string Shell, string Label, string Kind,
        DateTimeOffset CreatedAt);

    private static readonly JsonSerializerOptions JsonOpts =
        new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private List<PersistedShell> LoadPersisted()
    {
        try
        {
            if (!File.Exists(_stateFile)) return [];
            return JsonSerializer.Deserialize<List<PersistedShell>>(File.ReadAllText(_stateFile), JsonOpts) ?? [];
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not read {File}; starting with no remembered shells.", _stateFile);
            return [];
        }
    }

    private void Save()
    {
        try
        {
            lock (_saveLock)
            {
                var entries = _shells.Values
                    .OrderBy(s => s.CreatedAt)
                    .Select(s => new PersistedShell(
                        s.Id, s.SessionId, s.WorkingDirectory, s.ShellId, s.Label, s.Kind, s.CreatedAt))
                    // Plus the ones whose live host we could not reach — see _unadopted.
                    .Concat(_unadopted.Where(u => !_shells.ContainsKey(u.Id)))
                    .ToList();
                Directory.CreateDirectory(Path.GetDirectoryName(_stateFile)!);
                var tmp = _stateFile + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(entries, JsonOpts));
                File.Move(tmp, _stateFile, overwrite: true);
            }
        }
        catch (Exception ex) { _log.LogWarning(ex, "Could not save {File}", _stateFile); }
    }

    /// <summary>
    /// Detach from every shell without stopping it — the same contract session teardown has, and for
    /// the same reason: a tray Exit or an in-app update must leave a running build alone.
    /// </summary>
    public void Dispose()
    {
        foreach (var shell in _shells.Values)
        {
            try { shell.Client?.Dispose(); } catch { }
            shell.Client = null;
        }
    }

    /// <summary>One open shell tab and the host client behind it.</summary>
    private sealed class Shell(
        string id, string? sessionId, string workingDirectory, string shell, string label, string kind,
        DateTimeOffset createdAt)
    {
        public string Id { get; } = id;
        public string? SessionId { get; } = sessionId;
        public string WorkingDirectory { get; } = workingDirectory;
        /// <summary>The <see cref="ShellOption.Id"/> it was launched with.</summary>
        public string ShellId { get; } = shell;
        public string Label { get; } = label;
        public string Kind { get; } = kind;
        public DateTimeOffset CreatedAt { get; } = createdAt;
        public PtyHostClient? Client { get; set; }
        public ITerminal? Terminal => Client;
        public int ProcessId { get; set; }
        public bool Running { get; set; } = true;

        public ShellInfo ToInfo() => new(
            Id, SessionId, WorkingDirectory, ShellId, Label, Kind, ProcessId, CreatedAt, Running);
    }
}
