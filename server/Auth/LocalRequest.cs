using System.Net;

namespace Hangar.Server.Auth;

/// <summary>
/// Whether a request was made on this machine, by a person sitting at it — which is all an instance with no
/// password answers (see <see cref="TokenAuthMiddleware"/>). No password means no gate at all in front of a
/// shell, the whole disk and every session, so "local" is read strictly:
/// <list type="bullet">
/// <item>The connection comes from loopback.</item>
/// <item>It carries no proxy headers. A reverse proxy on this machine — <c>tailscale serve</c>, Caddy, a
/// tunnel — connects from loopback too, on behalf of someone who isn't here; the headers it adds are the only
/// sign of that, so any of them makes the request remote. (A proxy that adds none, such as nginx left at its
/// defaults, can't be told apart: put a password on any instance a proxy fronts.)</item>
/// <item>It is addressed to a loopback name (<c>Host</c>). A page on some other site that has had its name
/// re-pointed at 127.0.0.1 (DNS rebinding) reaches this port from the person's own browser, on loopback —
/// but under its own name.</item>
/// <item>It doesn't come from another site's page. A page anywhere can send a request here without reading
/// the answer — a form, an <c>&lt;img&gt;</c>, a link it navigates to — and with no password that is enough
/// to start a session, or to have this origin serve a file (an SVG with a script in it) that then can. Two
/// headers say where a request comes from, and a browser can't be made to lie in either:
/// <c>Sec-Fetch-Site</c>, which every current browser sends on every request, must be <c>same-origin</c> or
/// <c>none</c> (typed in, a bookmark, a link from another program); and an <c>Origin</c>, which browsers
/// send on writes, must be this node's own (<see cref="SocketOrigin"/>) — not merely some page on this
/// machine, since another port is another site (a dev server, a local tool with a hole in it). A client
/// that isn't a browser sends neither, and is let in: it could send any value it liked.</item>
/// </list>
/// The ticketed HTML preview (<c>GET /api/preview/…</c>) is spared the last check: it is loaded by a sandboxed
/// frame, whose origin is opaque, so its own requests read as cross-site with <c>Origin: null</c> — and the
/// ticket in its path, minted on this page and good for one folder, read-only, is its credential.
/// </summary>
public static class LocalRequest
{
    // What a reverse proxy or tunnel adds to say who, or what, it is forwarding for. Any one of them marks the
    // request as remote.
    private static readonly string[] ProxyHeaders =
    [
        "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-Port", "X-Forwarded-Server",
        "Forwarded", "Via", "X-Real-IP", "X-Original-Host", "X-Client-IP", "True-Client-IP", "CF-Connecting-IP",
        "Tailscale-User-Login",
    ];

    public static bool Is(HttpContext ctx)
    {
        var request = ctx.Request;
        if (ctx.Connection.RemoteIpAddress is not { } remote || !IsLoopback(remote)) return false;
        foreach (var header in ProxyHeaders)
            if (request.Headers.ContainsKey(header)) return false;
        if (!IsLoopbackHost(request.Host.Host)) return false;

        if (HttpMethods.IsGet(request.Method) && request.Path.StartsWithSegments("/api/preview")) return true;
        var site = request.Headers["Sec-Fetch-Site"].ToString();
        if (site.Length > 0 && site is not ("same-origin" or "none")) return false;
        return SocketOrigin.Allowed(request);
    }

    /// <summary>Loopback, including an IPv4 loopback address carried as IPv6 (<c>::ffff:127.0.0.1</c>).</summary>
    public static bool IsLoopback(IPAddress address) =>
        IPAddress.IsLoopback(address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address);

    private static bool IsLoopbackHost(string? host)
    {
        if (string.IsNullOrEmpty(host)) return false;
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)) return true;
        return IPAddress.TryParse(host.Trim('[', ']'), out var address) && IsLoopback(address);
    }

    /// <summary>Whether a Kestrel bind address (<c>http://0.0.0.0:5099</c>) is reachable from other machines.</summary>
    public static bool ExposedBeyondLoopback(string url)
    {
        if (!Uri.TryCreate(url.Replace("://+", "://0.0.0.0").Replace("://*", "://0.0.0.0"), UriKind.Absolute, out var uri))
            return true;
        if (uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return false;
        return !(IPAddress.TryParse(uri.Host.Trim('[', ']'), out var address) && IsLoopback(address));
    }
}
