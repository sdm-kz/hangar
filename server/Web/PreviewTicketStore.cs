using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace ClaudeWeb.Server.Web;

/// <summary>
/// Capability tickets for the HTML preview. A ticket is a random id standing for one directory on
/// disk; <c>GET /api/preview/{ticket}/{path}</c> serves that directory read-only for as long as the
/// ticket lives, and nothing else.
/// </summary>
/// <remarks>
/// <para>The preview frame is sandboxed without <c>allow-same-origin</c>, so the document inside it
/// has an opaque origin: it sends no cookies, and an <c>&lt;iframe src&gt;</c> navigation cannot set
/// an Authorization header either. Whatever lets that document fetch its own images has to live in
/// the URL — and it cannot be the browser's bearer token, which unlocks sessions, terminals and
/// <c>/api/fs/write</c>. A previewed page is arbitrary HTML, frequently written by an agent; a
/// script in it can read its own DOM, lift a token out of an <c>&lt;img src&gt;</c> and post it
/// anywhere. So the document is handed this instead: read-only, one directory, minutes long.</para>
/// <para>Expiry slides on every use, under a hard ceiling. Sliding alone would strand a preview left
/// open on screen — a lazily-loaded image an hour later would 404 against a page that still looks
/// alive. But sliding alone is also unbounded in the other direction, and the holder doing the
/// sliding need not be the user: a page that posted its own ticket to an attacker leaves something
/// that only has to be touched once every half hour to keep folder read alive forever, across the
/// user logging out. The ceiling is what makes the ticket genuinely short-lived; the slide only
/// decides whether it lapses earlier.</para>
/// <para>A viewer that outlives the ceiling is not left broken: the client mints again whenever it
/// reloads the frame, so an expired ticket costs a round trip, not a blank preview.</para>
/// </remarks>
public sealed class PreviewTicketStore
{
    // Long enough that a preview sitting open between glances doesn't go stale on its own — it is
    // refreshed by any request the page makes, including the entry document itself.
    private static readonly TimeSpan IdleTtl = TimeSpan.FromMinutes(30);

    // And the ceiling no amount of use can push past, so a leaked ticket stops working the same
    // afternoon whether or not someone is keeping it warm.
    private static readonly TimeSpan MaxLifetime = TimeSpan.FromHours(4);

    private sealed class Entry(string root)
    {
        public string Root { get; } = root;
        public DateTimeOffset Created { get; } = DateTimeOffset.UtcNow;
        public DateTimeOffset Expires { get; set; } = DateTimeOffset.UtcNow + IdleTtl;

        // One reading, used by everything that asks: idle too long, or simply old enough.
        public bool IsDead(DateTimeOffset now) => Expires <= now || Created + MaxLifetime <= now;
    }

    private readonly ConcurrentDictionary<string, Entry> _byTicket = new(StringComparer.Ordinal);
    // Reverse index so the same folder keeps the same ticket: switching between two files in a
    // folder, or flicking Source/Preview, would otherwise mint a fresh id every time and leave the
    // old ones lying around live until they timed out.
    private readonly ConcurrentDictionary<string, string> _byRoot = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// A ticket for <paramref name="rootDir"/>, reusing the live one for that directory if there is
    /// one. The caller is responsible for deciding the directory may be served at all.
    /// </summary>
    public string Mint(string rootDir)
    {
        var root = Path.GetFullPath(rootDir);
        Sweep();

        if (_byRoot.TryGetValue(root, out var existing)
            && _byTicket.TryGetValue(existing, out var live)
            && !live.IsDead(DateTimeOffset.UtcNow))
        {
            live.Expires = DateTimeOffset.UtcNow + IdleTtl;
            return existing;
        }

        var ticket = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        _byTicket[ticket] = new Entry(root);
        _byRoot[root] = ticket;
        return ticket;
    }

    /// <summary>
    /// The directory a ticket stands for, or null when it is unknown or has lapsed. Sliding the
    /// expiry is the point of resolving, so this is not a pure lookup.
    /// </summary>
    public string? Resolve(string? ticket)
    {
        if (string.IsNullOrEmpty(ticket) || !_byTicket.TryGetValue(ticket, out var entry)) return null;
        var now = DateTimeOffset.UtcNow;
        if (entry.IsDead(now))
        {
            Drop(ticket, entry);
            return null;
        }
        entry.Expires = now + IdleTtl;
        return entry.Root;
    }

    // Called on the way into a mint rather than on a timer: tickets are only created by someone
    // opening a preview, so that is also the only moment the collection can grow, and a store that
    // is never minted into never needs sweeping.
    private void Sweep()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var (ticket, entry) in _byTicket)
            if (entry.IsDead(now)) Drop(ticket, entry);
    }

    private void Drop(string ticket, Entry entry)
    {
        _byTicket.TryRemove(ticket, out _);
        // Only clear the reverse index if it still points at this ticket: the folder may have been
        // re-minted since, and taking the new ticket's entry out would leak it — live in _byTicket,
        // invisible to Mint, so every open of that folder would mint yet another.
        if (_byRoot.TryGetValue(entry.Root, out var current) && current == ticket)
            _byRoot.TryRemove(new KeyValuePair<string, string>(entry.Root, ticket));
    }
}
