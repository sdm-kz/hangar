using System.Collections.Concurrent;

namespace Hangar.Server.Widgets;

/// <summary>One thing an instance's view reported: an error it threw, or a line it logged.</summary>
public sealed record WidgetLogEntry(DateTimeOffset At, string Level, string Message, int? Line, int? Column);

/// <summary>
/// What each open instance's view has reported (docs/design/widgets.md §7, §9.3): errors thrown,
/// promises rejected, <c>console.error</c> and <c>console.warn</c>. The session that wrote a view
/// cannot see the page, and this is how it finds out the view is broken — <c>GET
/// /api/self/widgets/instances/{id}/log</c> reads it back.
/// </summary>
/// <remarks>Held in memory only, a short ring per instance: it is for the minutes after a write, not a history.</remarks>
public sealed class WidgetLog
{
    private const int MaxPerInstance = 50;
    private const int MaxInstances = 200;
    private const int MaxMessage = 2000;

    private sealed class Ring
    {
        public readonly Queue<WidgetLogEntry> Entries = new();
        public DateTimeOffset? LastData;
        public int? Rev;
        public DateTimeOffset Touched = DateTimeOffset.UtcNow;
    }

    private readonly ConcurrentDictionary<string, Ring> _rings = new(StringComparer.Ordinal);

    public void Add(string instance, int? rev, IEnumerable<WidgetLogEntry> entries)
    {
        var ring = _rings.GetOrAdd(instance, _ => new Ring());
        lock (ring)
        {
            // A view reloaded at a new revision starts a new story: what the old one threw is about
            // code that is no longer there.
            if (rev is not null && ring.Rev is not null && rev != ring.Rev) ring.Entries.Clear();
            if (rev is not null) ring.Rev = rev;
            ring.Touched = DateTimeOffset.UtcNow;
            foreach (var e in entries)
            {
                ring.Entries.Enqueue(e with { Message = e.Message.Length > MaxMessage ? e.Message[..MaxMessage] + "…" : e.Message });
                while (ring.Entries.Count > MaxPerInstance) ring.Entries.Dequeue();
            }
        }
        Trim();
    }

    /// <summary>Note that an instance's view was handed data, so the log can say whether it ever got any.</summary>
    public void Delivered(string instance, int? rev)
    {
        var ring = _rings.GetOrAdd(instance, _ => new Ring());
        lock (ring)
        {
            if (rev is not null && ring.Rev is not null && rev != ring.Rev) ring.Entries.Clear();
            if (rev is not null) ring.Rev = rev;
            ring.LastData = DateTimeOffset.UtcNow;
            ring.Touched = DateTimeOffset.UtcNow;
        }
    }

    public (IReadOnlyList<WidgetLogEntry> Entries, DateTimeOffset? LastData, int? Rev)? Get(string instance)
    {
        if (!_rings.TryGetValue(instance, out var ring)) return null;
        lock (ring) return (ring.Entries.ToList(), ring.LastData, ring.Rev);
    }

    private void Trim()
    {
        if (_rings.Count <= MaxInstances) return;
        foreach (var kv in _rings.OrderBy(kv => kv.Value.Touched).Take(_rings.Count - MaxInstances))
            _rings.TryRemove(kv.Key, out _);
    }
}
