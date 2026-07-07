using System.Collections.Concurrent;
using System.Text.Json;

namespace ClaudeWeb.Server.Sessions;

public sealed class SessionManagerOptions
{
    /// <summary>Path or command name used to launch Claude Code.</summary>
    public string ClaudeExecutable { get; set; } = "claude";

    /// <summary>
    /// Pre-accept Claude's workspace-trust prompt for the session's folder (writes
    /// hasTrustDialogAccepted into ~/.claude.json) so headless launches don't block on it.
    /// </summary>
    public bool AutoTrustFolders { get; set; } = true;

    /// <summary>
    /// Where launched sessions are persisted so they can be re-attached after the app restarts.
    /// Defaults to %LocalAppData%\ClaudeWeb\sessions.json when null/empty.
    /// </summary>
    public string? StateFile { get; set; }
}

/// <summary>Launches and tracks Remote-Control Claude sessions.</summary>
public sealed class SessionManager : IDisposable
{
    private readonly ConcurrentDictionary<string, ClaudeSession> _sessions = new();
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<SessionManager> _log;
    private readonly ExecutableSpec _exe;
    private readonly SessionManagerOptions _options;
    private readonly string _stateFile;
    private readonly object _saveLock = new();

    public SessionManager(SessionManagerOptions options, ILoggerFactory loggerFactory)
    {
        _options = options;
        _loggerFactory = loggerFactory;
        _log = loggerFactory.CreateLogger<SessionManager>();
        _exe = ClaudeExecutableResolver.Resolve(options.ClaudeExecutable);
        _log.LogInformation("Resolved claude executable: {File} {Prefix}", _exe.FileName, string.Join(' ', _exe.Prefix));

        _stateFile = string.IsNullOrWhiteSpace(options.StateFile)
            ? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ClaudeWeb", "sessions.json")
            : options.StateFile;

        LoadPersisted();
    }

    public IReadOnlyCollection<SessionInfo> List()
    {
        foreach (var s in _sessions.Values) s.Refresh();
        return _sessions.Values.OrderBy(s => s.CreatedAt).Select(s => s.ToInfo()).ToArray();
    }

    public SessionInfo? Get(string id)
    {
        if (!_sessions.TryGetValue(id, out var s)) return null;
        s.Refresh();
        return s.ToInfo();
    }

    /// <summary>Filesystem change counter for a session's working directory (null if unknown).</summary>
    public long? FsVersion(string id) => _sessions.TryGetValue(id, out var s) ? s.FsVersion : null;

    /// <summary>The live terminal stream for a session (null if unknown or no longer running).</summary>
    public Pty.TerminalChannel? GetTerminal(string id) =>
        _sessions.TryGetValue(id, out var s) ? s.Terminal : null;

    public SessionInfo Create(CreateSessionRequest req)
    {
        var dir = (req.WorkingDirectory ?? "").Trim();
        if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
            throw new DirectoryNotFoundException($"Working directory does not exist: {dir}");

        var fullDir = Path.GetFullPath(dir);

        // Pre-accept the workspace-trust prompt so the interactive session starts unattended.
        if (_options.AutoTrustFolders)
            ClaudeTrustStore.EnsureTrusted(fullDir, _log);

        var session = new ClaudeSession(
            req with { WorkingDirectory = fullDir },
            _exe,
            _loggerFactory.CreateLogger<ClaudeSession>());

        _sessions[session.Id] = session;
        session.Start();
        SavePersisted();
        return session.ToInfo();
    }

    /// <summary>Remove a session. <paramref name="stopProcess"/> also kills the claude process.</summary>
    public bool Remove(string id, bool stopProcess)
    {
        if (!_sessions.TryRemove(id, out var s)) return false;
        if (stopProcess) s.Stop();
        s.Dispose();
        SavePersisted();
        return true;
    }

    // ---- Persistence: re-attach to still-running Remote Control sessions across app restarts -----

    private void LoadPersisted()
    {
        List<PersistedSession>? saved = null;
        try
        {
            if (File.Exists(_stateFile))
                saved = JsonSerializer.Deserialize<List<PersistedSession>>(File.ReadAllText(_stateFile));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not read persisted sessions from {File}", _stateFile);
        }
        if (saved is null || saved.Count == 0) return;

        foreach (var p in saved)
        {
            var s = ClaudeSession.FromPersisted(p, _exe, _loggerFactory.CreateLogger<ClaudeSession>());
            if (s.TryReattach())
                _sessions[s.Id] = s;
            else
                s.Dispose(); // process gone — drop it
        }
        _log.LogInformation("Re-attached {Live}/{Total} persisted sessions", _sessions.Count, saved.Count);

        // Rewrite the file so it only holds sessions that actually came back.
        if (_sessions.Count != saved.Count) SavePersisted();
    }

    private void SavePersisted()
    {
        lock (_saveLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_stateFile)!);
                var list = _sessions.Values
                    .OrderBy(s => s.CreatedAt)
                    .Select(s => s.ToPersisted())
                    .ToList();
                File.WriteAllText(_stateFile, JsonSerializer.Serialize(list, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Could not persist sessions to {File}", _stateFile);
            }
        }
    }

    public void Dispose()
    {
        // Detach only: leave launched sessions running so Remote Control survives a service restart.
        foreach (var s in _sessions.Values) s.Dispose();
        _sessions.Clear();
    }
}
