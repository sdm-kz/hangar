using System.Text.Json;

namespace Hangar.Server.Push;

/// <summary>A browser/PWA Web Push subscription: the push-service endpoint plus its two keys.</summary>
public sealed record PushSubscriptionEntry(string Endpoint, string P256dh, string Auth);

/// <summary>
/// Server-side store of Web Push subscriptions, one per browser/PWA install that opted in. Persisted
/// to %LocalAppData%\Hangar\push-subscriptions.json so they survive restarts and are shared across
/// the (single-user) install. Deduped by <see cref="PushSubscriptionEntry.Endpoint"/> — the push
/// service mints a unique endpoint per subscription, and re-subscribing just refreshes the keys.
/// Mirrors the lock + load/save shape of <c>RecentsStore</c>.
/// </summary>
public sealed class PushSubscriptionStore
{
    private readonly string _file;
    private readonly ILogger<PushSubscriptionStore> _log;
    private readonly object _lock = new();
    private List<PushSubscriptionEntry> _subs = new();

    public PushSubscriptionStore(ILogger<PushSubscriptionStore> log)
    {
        _log = log;
        _file = AppDataFolder.PathFor("push-subscriptions.json");
        Load();
    }

    public IReadOnlyList<PushSubscriptionEntry> All()
    {
        lock (_lock) return _subs.ToArray();
    }

    /// <summary>Add or refresh a subscription (matched by endpoint).</summary>
    public void Add(PushSubscriptionEntry sub)
    {
        if (string.IsNullOrWhiteSpace(sub.Endpoint) ||
            string.IsNullOrWhiteSpace(sub.P256dh) ||
            string.IsNullOrWhiteSpace(sub.Auth)) return;
        lock (_lock)
        {
            _subs.RemoveAll(x => x.Endpoint == sub.Endpoint);
            _subs.Add(sub);
            Save();
        }
    }

    /// <summary>Remove a subscription by endpoint (explicit unsubscribe, or pruned after 404/410).</summary>
    public void Remove(string endpoint)
    {
        if (string.IsNullOrWhiteSpace(endpoint)) return;
        lock (_lock)
        {
            var removed = _subs.RemoveAll(x => x.Endpoint == endpoint);
            if (removed > 0) Save();
        }
    }

    private sealed record Persisted(List<PushSubscriptionEntry>? Subscriptions);

    // Set when the state file exists but couldn't be read, which makes Save() stand down — see Load().
    private bool _unreadable;

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(_file));
            _subs = (p?.Subscriptions ?? new())
                .Where(s => s is not null && !string.IsNullOrWhiteSpace(s.Endpoint))
                .ToList();
        }
        // A failed read leaves the store empty, and the next save would write that emptiness back
        // over the file. Which repair that calls for turns on why the read failed — see StateFile.
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            // Couldn't get at the file — locked, or permissions. What is in it is presumably fine, so
            // it stays exactly where it is and nothing is written over it for the rest of the run.
            _log.LogWarning(ex, "Could not read push subscriptions from {File}; it will not be written this run", _file);
            _subs.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            // Could not make sense of it — truncated by a stop mid-write, or hand-edited into something
            // that won't load. It will never read any better, so set it aside and carry on from a clean
            // slate; if it can't even be moved, then it must not be written over either.
            _log.LogWarning(ex, "Could not load push subscriptions from {File}; setting it aside", _file);
            _subs.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, "push subscriptions");
        }
    }

    private void Save()
    {
        if (_unreadable)
        {
            // Debug, not a warning: Load() already said this once, loudly, and this runs on every save.
            _log.LogDebug("Not writing push subscriptions: {File} could not be read at startup", _file);
            return;
        }
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(
                new Persisted(_subs), new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist push subscriptions to {File}", _file);
        }
    }
}
