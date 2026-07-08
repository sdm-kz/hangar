using System.Text.Json;

namespace ClaudeWeb.Server.Sessions;

/// <summary>A reusable launch preset: everything needed to relaunch the same session.</summary>
public sealed record RecentSession(
    string WorkingDirectory,
    string Name,
    string Command,
    string Model,
    bool RemoteControl,
    string PermissionMode);

/// <summary>The remembered launch presets and folders, shared across every device/browser.</summary>
public sealed record Recents(
    IReadOnlyList<RecentSession> Sessions,
    IReadOnlyList<string> Folders);

/// <summary>
/// Server-side store for the "recent" launch presets and folders shown in the New Session dialog.
/// Persisted to %LocalAppData%\ClaudeWeb\recents.json so they follow the user across devices — these
/// previously lived in each browser's localStorage and so didn't sync. Owns the dedupe/cap logic
/// that used to run client-side.
/// </summary>
public sealed class RecentsStore
{
    private const int MaxSessions = 12;
    private const int MaxFolders = 8;

    private readonly string _file;
    private readonly ILogger<RecentsStore> _log;
    private readonly object _lock = new();
    private List<RecentSession> _sessions = new();
    private List<string> _folders = new();

    public RecentsStore(ILogger<RecentsStore> log)
    {
        _log = log;
        _file = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "recents.json");
        Load();
    }

    public Recents Get()
    {
        lock (_lock) return Snapshot();
    }

    /// <summary>Save (or move-to-front) a preset. Presets with the same identity collapse to one.</summary>
    public Recents AddSession(RecentSession r)
    {
        if (string.IsNullOrWhiteSpace(r.WorkingDirectory)) return Get();
        var norm = Normalize(r);
        var sig = Sig(norm);
        lock (_lock)
        {
            _sessions.RemoveAll(x => Sig(x) == sig);
            _sessions.Insert(0, norm);
            if (_sessions.Count > MaxSessions) _sessions = _sessions.Take(MaxSessions).ToList();
            Save();
            return Snapshot();
        }
    }

    public Recents RemoveSession(RecentSession r)
    {
        var sig = Sig(Normalize(r));
        lock (_lock)
        {
            _sessions.RemoveAll(x => Sig(x) == sig);
            Save();
            return Snapshot();
        }
    }

    public Recents AddFolder(string? path)
    {
        var p = (path ?? "").Trim();
        if (p.Length == 0) return Get();
        lock (_lock)
        {
            _folders.RemoveAll(x => string.Equals(x, p, StringComparison.OrdinalIgnoreCase));
            _folders.Insert(0, p);
            if (_folders.Count > MaxFolders) _folders = _folders.Take(MaxFolders).ToList();
            Save();
            return Snapshot();
        }
    }

    public Recents RemoveFolder(string? path)
    {
        var p = (path ?? "").Trim();
        lock (_lock)
        {
            _folders.RemoveAll(x => string.Equals(x, p, StringComparison.OrdinalIgnoreCase));
            Save();
            return Snapshot();
        }
    }

    // ---- helpers -------------------------------------------------------------------------------

    private Recents Snapshot() => new(_sessions.ToArray(), _folders.ToArray());

    private static RecentSession Normalize(RecentSession r) => r with
    {
        WorkingDirectory = r.WorkingDirectory.Trim(),
        Name = (r.Name ?? "").Trim(),
        Command = (r.Command ?? "").Trim(),
        Model = r.Model ?? "",
        PermissionMode = string.IsNullOrEmpty(r.PermissionMode) ? "default" : r.PermissionMode,
    };

    /// <summary>Identity used to dedupe — mirrors the client's original signature.</summary>
    private static string Sig(RecentSession r) => string.Join(' ',
        r.WorkingDirectory.ToLowerInvariant(),
        r.Name,
        r.Command,
        r.Model,
        r.RemoteControl ? "rc" : "norc",
        r.PermissionMode);

    private sealed record Persisted(List<RecentSession>? Sessions, List<string>? Folders);

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(_file));
            if (p is null) return;
            _sessions = (p.Sessions ?? new())
                .Where(s => s is not null && !string.IsNullOrWhiteSpace(s.WorkingDirectory))
                .Select(Normalize)
                .Take(MaxSessions)
                .ToList();
            _folders = (p.Folders ?? new())
                .Where(f => !string.IsNullOrWhiteSpace(f))
                .Take(MaxFolders)
                .ToList();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not read recents from {File}", _file);
        }
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            File.WriteAllText(_file, JsonSerializer.Serialize(
                new Persisted(_sessions, _folders),
                new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist recents to {File}", _file);
        }
    }
}
