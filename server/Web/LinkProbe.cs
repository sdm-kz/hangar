using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;

namespace Hangar.Server.Web;

/// <summary>
/// What the server could learn about a web page a session is linking to: what it is called, what its
/// icon is, and — the part the browser cannot find out for itself — whether it will render inside an
/// iframe at all.
///
/// <para>A page that forbids framing (<c>X-Frame-Options</c>, or a CSP <c>frame-ancestors</c> that
/// does not name us) is refused by the browser <b>silently</b>: the iframe fires its load event and
/// stays blank, and script on our side cannot tell that apart from a slow page, because reading
/// anything about a cross-origin frame is what the same-origin policy exists to stop. Those headers
/// are only readable by something that is not a browser, which is why this lives on the server.</para>
/// </summary>
/// <param name="Url">The URL actually fetched, after redirects — what the iframe should point at.</param>
/// <param name="Embeddable">True/false when the headers settled it, null when the page was unreachable.</param>
/// <param name="BlockedBy">The header that refuses framing, quoted for the UI to show; null when none does.</param>
/// <param name="Error">Why the probe failed, when it did. The link is still usable — just unexamined.</param>
public sealed record LinkProbe(
    string Url,
    string? Title,
    string? Icon,
    bool? Embeddable,
    string? BlockedBy,
    string? Error);

/// <summary>
/// Fetches <see cref="LinkProbe"/> for a URL. One shared client: this runs on a click, not in a
/// loop, and a probe that hangs must not hold a request for longer than a person will wait.
/// </summary>
public sealed class LinkProbeService
{
    // Enough of a page for its <head>; the rest is body we have no use for. A page that puts its
    // <title> past this is pathological, and the host name stands in for one anyway.
    private const int MaxBytes = 192 * 1024;

    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(8);

    private readonly HttpClient _http;
    private readonly ILogger<LinkProbeService> _log;

    public LinkProbeService(ILogger<LinkProbeService> log)
    {
        _log = log;
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 5,
            AutomaticDecompression = DecompressionMethods.All,
        };
        // A self-hosted Jira or wiki on the LAN is exactly the thing worth linking to, and those
        // habitually carry a certificate nothing here trusts. We read a title and a set of headers,
        // never credentials, so a bad certificate is not worth failing the probe over.
        handler.SslOptions.RemoteCertificateValidationCallback = (_, _, _, _) => true;

        _http = new HttpClient(handler)
        {
            Timeout = ProbeTimeout,
            MaxResponseContentBufferSize = MaxBytes,
        };
        // Plenty of sites serve a stripped-down page (or none at all) to something that does not look
        // like a browser, and the framing headers can differ with it.
        _http.DefaultRequestHeaders.UserAgent.ParseAdd(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/124.0 Safari/537.36 Hangar/1.0");
        _http.DefaultRequestHeaders.Accept.ParseAdd("text/html,application/xhtml+xml,*/*;q=0.8");
    }

    /// <summary>
    /// Look at <paramref name="url"/>. Never throws for a page's own sake: an unreachable or hostile
    /// host comes back as a result with <c>Error</c> set and <c>Embeddable</c> unknown, because a
    /// link the user typed is worth keeping whether or not we could read it.
    /// </summary>
    public async Task<LinkProbe> ProbeAsync(string url, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            return new LinkProbe(url, null, null, null, null, "Only http and https links can be opened here.");

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, uri);
            // Headers first: the framing verdict is in them, and a page we are refused (401/403) still
            // answers the question, so the status code is deliberately not checked.
            using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            var final = res.RequestMessage?.RequestUri ?? uri;
            var (embeddable, blockedBy) = ReadFramingPolicy(res);

            string? title = null, icon = null;
            if (LooksLikeHtml(res.Content.Headers.ContentType))
            {
                var html = await ReadHeadAsync(res, ct);
                title = ExtractTitle(html);
                icon = ExtractIcon(html, final);
            }

            return new LinkProbe(final.ToString(), title, icon ?? DefaultIcon(final), embeddable, blockedBy, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Debug, not warning: an unreachable link is the user's business, not a fault of ours.
            _log.LogDebug(ex, "Could not probe {Url}", url);
            return new LinkProbe(uri.ToString(), null, DefaultIcon(uri), null, null, Describe(ex));
        }
    }

    /// <summary>
    /// Whether the page lets itself be framed, per the two headers browsers enforce.
    /// <c>frame-ancestors</c> wins over <c>X-Frame-Options</c> where both are present, which is what
    /// the CSP spec says browsers must do.
    /// </summary>
    private static (bool? Embeddable, string? BlockedBy) ReadFramingPolicy(HttpResponseMessage res)
    {
        foreach (var csp in Headers(res, "Content-Security-Policy"))
        {
            var ancestors = FrameAncestors(csp);
            if (ancestors is null) continue;
            // "*" (or a bare scheme source) lets anyone frame it; anything else is a list this app is
            // almost certainly not on — it is served from a LAN address the site never heard of.
            var open = ancestors.Any(a => a is "*" or "http:" or "https:");
            return open
                ? (true, null)
                : (false, $"Content-Security-Policy: frame-ancestors {string.Join(' ', ancestors)}");
        }

        foreach (var xfo in Headers(res, "X-Frame-Options"))
        {
            var value = xfo.Trim();
            if (value.Length == 0) continue;
            // Every legal value — DENY, SAMEORIGIN, ALLOW-FROM <origin> — refuses a third-party frame.
            return (false, $"X-Frame-Options: {value.ToUpperInvariant()}");
        }

        return (true, null);
    }

    private static IEnumerable<string> Headers(HttpResponseMessage res, string name) =>
        res.Headers.TryGetValues(name, out var v) ? v
        : res.Content.Headers.TryGetValues(name, out var cv) ? cv
        : [];

    /// <summary>The sources listed by a CSP's frame-ancestors directive, or null if it has none.</summary>
    private static List<string>? FrameAncestors(string csp)
    {
        foreach (var directive in csp.Split(';',
                     StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = directive.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0 || !parts[0].Equals("frame-ancestors", StringComparison.OrdinalIgnoreCase))
                continue;
            return [.. parts.Skip(1)];
        }
        return null;
    }

    private static bool LooksLikeHtml(MediaTypeHeaderValue? type) =>
        type?.MediaType is null ||
        type.MediaType.Contains("html", StringComparison.OrdinalIgnoreCase) ||
        type.MediaType.Contains("xml", StringComparison.OrdinalIgnoreCase);

    /// <summary>Read at most <see cref="MaxBytes"/> of the response — enough to hold a &lt;head&gt;.</summary>
    private static async Task<string> ReadHeadAsync(HttpResponseMessage res, CancellationToken ct)
    {
        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        var buffer = new byte[MaxBytes];
        var read = 0;
        while (read < buffer.Length)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(read), ct);
            if (n == 0) break;
            read += n;
        }
        // Charset is not honoured: a title is being shown, not round-tripped, and the encodings that
        // matter for one are UTF-8 or an ASCII superset either way.
        return Encoding.UTF8.GetString(buffer, 0, read);
    }

    private static readonly Regex TitleRe = new(@"<title[^>]*>(?<t>.*?)</title>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled);
    private static readonly Regex WhitespaceRe = new(@"\s+", RegexOptions.Compiled);

    // Attribute order is not fixed in the wild, so rel and href are each found within one <link> tag
    // rather than in sequence.
    private static readonly Regex LinkTagRe = new(@"<link\b[^>]*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex AttrRe =
        new(@"(?<name>[a-zA-Z-]+)\s*=\s*(?:""(?<v>[^""]*)""|'(?<v>[^']*)'|(?<v>[^\s>]+))",
            RegexOptions.Compiled);

    private static string? ExtractTitle(string html)
    {
        var m = TitleRe.Match(html);
        if (!m.Success) return null;
        var text = WhitespaceRe.Replace(WebUtility.HtmlDecode(m.Groups["t"].Value), " ").Trim();
        return text.Length == 0 ? null : text.Length > 200 ? text[..200] : text;
    }

    private static string? ExtractIcon(string html, Uri baseUri)
    {
        string? best = null;
        foreach (Match tag in LinkTagRe.Matches(html))
        {
            string? rel = null, href = null;
            foreach (Match a in AttrRe.Matches(tag.Value))
            {
                var name = a.Groups["name"].Value;
                if (name.Equals("rel", StringComparison.OrdinalIgnoreCase)) rel = a.Groups["v"].Value;
                else if (name.Equals("href", StringComparison.OrdinalIgnoreCase)) href = a.Groups["v"].Value;
            }
            if (rel is null || href is null) continue;
            if (!rel.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                    .Any(r => r.Equals("icon", StringComparison.OrdinalIgnoreCase) ||
                              r.Equals("shortcut", StringComparison.OrdinalIgnoreCase) ||
                              r.Equals("apple-touch-icon", StringComparison.OrdinalIgnoreCase)))
                continue;
            if (!Uri.TryCreate(baseUri, WebUtility.HtmlDecode(href), out var abs)) continue;
            // A page declaring `href="data:,"` is telling the browser it has no icon — a real one is
            // an inline image. Taking it at face value would put a broken image in the tab.
            if (abs.Scheme == "data" &&
                !abs.OriginalString.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase)) continue;
            if (abs.Scheme != Uri.UriSchemeHttp && abs.Scheme != Uri.UriSchemeHttps && abs.Scheme != "data")
                continue;
            // First one wins unless a later tag is an SVG, which scales to whatever size the tab wants.
            if (best is null || abs.AbsolutePath.EndsWith(".svg", StringComparison.OrdinalIgnoreCase))
                best = abs.ToString();
        }
        return best;
    }

    /// <summary>The conventional icon location, for a site that declares none.</summary>
    private static string DefaultIcon(Uri uri) => new Uri(uri, "/favicon.ico").ToString();

    private static string Describe(Exception ex) => ex switch
    {
        TaskCanceledException => "The site did not answer in time.",
        HttpRequestException { HttpRequestError: HttpRequestError.NameResolutionError } =>
            "That host name could not be resolved.",
        HttpRequestException { HttpRequestError: HttpRequestError.ConnectionError } =>
            "Could not connect to that host.",
        HttpRequestException e => e.Message,
        _ => ex.Message,
    };
}
