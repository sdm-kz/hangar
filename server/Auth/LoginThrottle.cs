using System.Net;
using System.Net.Sockets;

namespace Hangar.Server.Auth;

/// <summary>
/// Slows down password guessing: the browser login (<c>/api/auth/login</c>) and a node pairing with this one
/// (<c>/api/nodes/pair</c>) both check this node's one password, so they draw on the same budget per client.
/// A handful of tries are free; past that each further one waits twice as long as the last, up to a ceiling.
/// In memory only — a restart forgives everyone, which costs an attacker a restart they can't cause.
/// </summary>
/// <remarks>
/// <para>An attempt counts as a failure from the moment it starts and is forgiven when it succeeds, so a burst
/// of them in parallel can't all slip in under the limit before the first one has been checked (each costs a
/// PBKDF2 hash, slow on purpose).</para>
/// <para>The client is its address — see <see cref="ClientKey"/>. The table of them is bounded: idle entries
/// are swept now and then, and when it is still full the one heard from longest ago makes room. Someone with
/// that many addresses can push a locked-out one out early, but every address still pays its own five
/// failures, and an IPv6 network counts once however many addresses it hands out.</para>
/// </remarks>
public sealed class LoginThrottle
{
    private const int FreeAttempts = 5;
    private static readonly TimeSpan FirstLockout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan MaxLockout = TimeSpan.FromMinutes(15);
    // A client quiet for this long starts over with its free attempts.
    private static readonly TimeSpan Forget = TimeSpan.FromHours(1);
    private const int MaxTrackedClients = 10_000;
    private static readonly TimeSpan SweepEvery = TimeSpan.FromMinutes(1);

    private readonly Dictionary<string, (int Failures, DateTimeOffset Last)> _clients = new();
    private readonly object _lock = new();
    private DateTimeOffset _lastSweep = DateTimeOffset.MinValue;

    /// <summary>
    /// Start an attempt for <paramref name="client"/>. False while it is locked out, with how long is left;
    /// otherwise the attempt is counted, to be forgiven by <see cref="Succeeded"/>.
    /// </summary>
    public bool TryBegin(string client, out TimeSpan retryAfter)
    {
        var now = DateTimeOffset.UtcNow;
        lock (_lock)
        {
            var entry = _clients.TryGetValue(client, out var found) && now - found.Last <= Forget
                ? found
                : (Failures: 0, Last: now);
            if (entry.Failures >= FreeAttempts)
            {
                var doublings = Math.Min(entry.Failures - FreeAttempts, 10);
                var lockout = TimeSpan.FromTicks(Math.Min(FirstLockout.Ticks << doublings, MaxLockout.Ticks));
                retryAfter = entry.Last + lockout - now;
                if (retryAfter > TimeSpan.Zero) return false;
            }
            if (!_clients.ContainsKey(client)) MakeRoom(now);
            _clients[client] = (entry.Failures + 1, now);
            retryAfter = TimeSpan.Zero;
            return true;
        }
    }

    /// <summary>The attempt was right: forget the client's failures.</summary>
    public void Succeeded(string client)
    {
        lock (_lock) _clients.Remove(client);
    }

    // Under _lock. A sweep walks the whole table, so it runs at most once a SweepEvery however fast new
    // clients arrive; past that, a full table gives up its stalest entry.
    private void MakeRoom(DateTimeOffset now)
    {
        if (_clients.Count < MaxTrackedClients) return;
        if (now - _lastSweep >= SweepEvery)
        {
            _lastSweep = now;
            foreach (var (key, old) in _clients.ToList())
                if (now - old.Last > Forget) _clients.Remove(key);
        }
        if (_clients.Count < MaxTrackedClients) return;
        var stalest = _clients.MinBy(kv => kv.Value.Last).Key;
        _clients.Remove(stalest);
    }

    /// <summary>
    /// Who is asking, for counting their attempts: the address the request came from — for IPv6, its /64,
    /// since one machine is routinely handed a whole /64 and could otherwise start afresh on every attempt.
    /// </summary>
    /// <remarks>
    /// Behind a reverse proxy on this machine (<c>tailscale serve</c>, Caddy, …) the connection is from
    /// loopback for everyone. There the client is the address the proxy appended — the last entry of
    /// <c>X-Forwarded-For</c>, else of <c>Forwarded: for=</c>, the one a client can't write itself. Only
    /// trusted from loopback: anyone else could send any header they liked. A proxy that sends neither puts
    /// everyone behind it in one bucket — a stranger's guesses then hold up the owner as well, which is the
    /// safe way round to be wrong.
    /// </remarks>
    public static string ClientKey(HttpContext ctx)
    {
        var remote = ctx.Connection.RemoteIpAddress;
        if (remote is not null && LocalRequest.IsLoopback(remote) && ForwardedClient(ctx.Request) is { } client)
            return Bucket(client);
        return remote is null ? "?" : Bucket(remote);
    }

    private static IPAddress? ForwardedClient(HttpRequest request)
    {
        var xff = request.Headers["X-Forwarded-For"].ToString()
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .LastOrDefault();
        if (ParseHostAndPort(xff) is { } fromXff) return fromXff;

        // Forwarded: for=1.2.3.4;proto=https, for="[2001:db8::1]:4711"
        var lastFor = request.Headers["Forwarded"].ToString()
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .LastOrDefault()?
            .Split(';', StringSplitOptions.TrimEntries)
            .FirstOrDefault(p => p.StartsWith("for=", StringComparison.OrdinalIgnoreCase));
        return ParseHostAndPort(lastFor?[4..].Trim('"'));
    }

    /// <summary>An address as a proxy writes one: bare, with a port (<c>1.2.3.4:5678</c>), or bracketed (<c>[::1]:80</c>).</summary>
    private static IPAddress? ParseHostAndPort(string? value)
    {
        if (string.IsNullOrEmpty(value)) return null;
        if (IPAddress.TryParse(value, out var bare)) return bare;
        if (value.StartsWith('[') && value.IndexOf(']') is var close and > 0)
            return IPAddress.TryParse(value[1..close], out var v6) ? v6 : null;
        if (value.LastIndexOf(':') is var colon and > 0 && value.IndexOf(':') == colon)
            return IPAddress.TryParse(value[..colon], out var v4) ? v4 : null;
        return null;
    }

    private static string Bucket(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily != AddressFamily.InterNetworkV6) return address.ToString();
        var bytes = address.GetAddressBytes();
        Array.Clear(bytes, 8, 8);
        return new IPAddress(bytes) + "/64";
    }
}
