using System.Text.Json;

namespace ClaudeWeb.Server.Push;

/// <summary>A browser/PWA Web Push subscription: the push-service endpoint plus its two keys.</summary>
public sealed record PushSubscriptionEntry(string Endpoint, string P256dh, string Auth);

/// <summary>
/// Server-side store of Web Push subscriptions, one per browser/PWA install that opted in. Persisted
/// to %LocalAppData%\ClaudeWeb\push-subscriptions.json so they survive restarts and are shared across
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
        _file = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "push-subscriptions.json");
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
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not read push subscriptions from {File}", _file);
        }
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            File.WriteAllText(_file, JsonSerializer.Serialize(
                new Persisted(_subs), new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist push subscriptions to {File}", _file);
        }
    }
}
