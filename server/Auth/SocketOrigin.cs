namespace Hangar.Server.Auth;

/// <summary>
/// Whether a browser opening one of this node's sockets is on this node's own page. A socket is a shell (a
/// terminal, a shell tab) or the live picture of every session, and a browser can't send it a header — its
/// token rides in the URL. So the token alone is the whole credential, and a page that has come by one
/// (a leak, a peer's page relayed through this node) could open them from anywhere. Browsers always say
/// where a socket comes from, and can't be made to lie about it; this holds them to this node's own origin.
/// </summary>
/// <remarks>
/// <para>No <c>Origin</c> at all is allowed: that is not a browser — the tray, another node's mesh, a script —
/// and a client that isn't a browser could send any Origin it liked, so refusing it would only be theatre.</para>
/// <para>Same origin means the host the request was made to: <c>Host</c>, or <c>X-Forwarded-Host</c> behind a
/// reverse proxy that rewrites it. A browser can't set that one on a socket either.</para>
/// <para>Nothing is let through for being on this machine: another port is another site (a peer's page on a
/// second instance, any local web server). The Vite dev server, which proxies <c>/hub</c> from its own port,
/// presents the backend's origin instead (web/vite.config.ts).</para>
/// </remarks>
public static class SocketOrigin
{
    public static bool Allowed(HttpRequest request)
    {
        var origin = request.Headers.Origin.ToString();
        if (string.IsNullOrEmpty(origin)) return true;
        // "null" (a sandboxed frame, a file: page) and anything else unparseable is no origin of ours.
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var from) || from.Scheme is not ("http" or "https")) return false;

        if (Same(from, request.Host.Value)) return true;
        foreach (var forwarded in request.Headers["X-Forwarded-Host"].ToString().Split(',', StringSplitOptions.TrimEntries))
            if (Same(from, forwarded)) return true;
        return false;
    }

    // The host and port the page is on against those the request was made to — read with the page's scheme, so
    // a Host that leaves the default port off (or spells it out) compares the same.
    private static bool Same(Uri from, string? host) =>
        !string.IsNullOrEmpty(host)
        && Uri.TryCreate($"{from.Scheme}://{host}", UriKind.Absolute, out var to)
        && string.Equals(from.Host, to.Host, StringComparison.OrdinalIgnoreCase)
        && from.Port == to.Port;
}
