using System.Text.Json;
using Hangar.Server.Sessions;

namespace Hangar.Server.Remote;

/// <summary>
/// The SSH connections saved for the sidebar's Files tab, persisted to
/// %LocalAppData%\Hangar\ssh-connections.json so every browser pointed at this app offers the same
/// ones. A project keeps its own (see <see cref="ProjectStore.SaveConnection"/>); these belong to no
/// project. Only the parameters are kept -- host, port, user, how to authenticate, a key file's path,
/// a start folder -- never a password or a passphrase: those are asked for when connecting, and live
/// in <see cref="RemoteManager"/>'s memory for as long as the connection does.
/// </summary>
public sealed class SavedConnectionStore
{
    private const int MaxConnections = 50;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly string _file;
    private readonly ILogger<SavedConnectionStore> _log;
    private readonly object _lock = new();
    private List<RemoteConnection> _connections = new();
    private bool _unreadable;

    public SavedConnectionStore(ILogger<SavedConnectionStore> log)
    {
        _log = log;
        _file = AppDataFolder.PathFor("ssh-connections.json");
        Load();
    }

    public IReadOnlyList<RemoteConnection> List()
    {
        lock (_lock) return _connections.ToList();
    }

    /// <summary>
    /// Save a connection: a new one when it has no id (or one not saved here), otherwise a replacement
    /// of the one it names. Null when it has no usable host, or the list is full.
    /// </summary>
    public IReadOnlyList<RemoteConnection>? Save(RemoteConnection? connection)
    {
        if (connection is null) return null;
        lock (_lock)
        {
            var existing = string.IsNullOrWhiteSpace(connection.Id)
                ? -1
                : _connections.FindIndex(c => c.Id == connection.Id);
            var clean = ProjectStore.CleanConnection(existing < 0 ? connection with { Id = Guid.NewGuid().ToString("n") } : connection);
            if (clean is null) return null;
            if (existing < 0)
            {
                if (_connections.Count >= MaxConnections) return null;
                _connections.Add(clean);
            }
            else _connections[existing] = clean;
            Persist();
            return _connections.ToList();
        }
    }

    public IReadOnlyList<RemoteConnection> Delete(string id)
    {
        lock (_lock)
        {
            if (_connections.RemoveAll(c => c.Id == id) > 0) Persist();
            return _connections.ToList();
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            _connections = (JsonSerializer.Deserialize<List<RemoteConnection>>(File.ReadAllText(_file), Json) ?? new())
                .Where(c => c is not null && !string.IsNullOrWhiteSpace(c.Id))
                .Select(ProjectStore.CleanConnection)
                .Where(c => c is not null)
                .Select(c => c!)
                .DistinctBy(c => c.Id)
                .Take(MaxConnections)
                .ToList();
        }
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            _log.LogWarning(ex, "Could not read saved SSH connections from {File}; it will not be written this run", _file);
            _connections = new();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not load saved SSH connections from {File}; setting it aside", _file);
            _connections = new();
            _unreadable = !StateFile.SetAside(_file, _log, "saved SSH connections");
        }
    }

    private void Persist()
    {
        if (_unreadable) return;
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(_connections, Json));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist saved SSH connections to {File}", _file);
        }
    }
}
