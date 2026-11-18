using System.Reflection;
using System.Text.RegularExpressions;

namespace Hangar.Server.Widgets;

/// <summary>
/// What Hangar tells a Claude session about writing widgets (<c>GET /api/self/widgets/guide</c>), and the
/// pieces of it the runtime uses too: the manifest schema every write is checked against, and the bridge
/// script put in front of every view. All of it is embedded in the build (<c>server/Widgets/Guide</c>), so
/// a command file installed months ago still writes widgets for the Hangar that is running now.
/// </summary>
public static class WidgetGuide
{
    public const int Contract = 1;
    // Embedded as Hangar.Server.widgets/<path under Guide> (see the csproj); MSBuild may write the
    // separators either way round, so names are compared with them folded to '/'.
    private const string Prefix = "Hangar.Server.widgets/";

    private static readonly Lazy<Dictionary<string, string>> Names = new(() =>
        Assembly.GetExecutingAssembly().GetManifestResourceNames()
            .Where(n => n.Replace('\\', '/').StartsWith(Prefix, StringComparison.Ordinal))
            .ToDictionary(n => n.Replace('\\', '/')[Prefix.Length..], n => n, StringComparer.Ordinal));

    /// <summary>An embedded file of the guide, by its path under <c>server/Widgets/Guide</c> ("bridge.js", "examples/x/widget.json").</summary>
    public static string Resource(string path)
    {
        if (!Names.Value.TryGetValue(path, out var name))
            throw new FileNotFoundException($"embedded widget guide file {path} is missing", path);
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)!;
        using var r = new StreamReader(s);
        return r.ReadToEnd();
    }

    private static readonly Lazy<string> Bridge = new(() => Resource("bridge.js"));

    /// <summary>The worked examples, each a complete widget by file, from the embedded <c>examples/&lt;name&gt;/…</c>.</summary>
    public static IReadOnlyList<(string Name, Dictionary<string, string> Files)> Examples()
    {
        var byName = new SortedDictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        foreach (var path in Names.Value.Keys.Where(k => k.StartsWith("examples/", StringComparison.Ordinal)))
        {
            var rest = path["examples/".Length..];                    // jira-ticket/view.html
            var slash = rest.IndexOf('/');
            if (slash <= 0) continue;
            var name = rest[..slash];
            if (!byName.TryGetValue(name, out var files)) byName[name] = files = new(StringComparer.Ordinal);
            files[rest[(slash + 1)..]] = Resource(path);
        }
        return byName.Select(kv => (kv.Key, kv.Value)).ToList();
    }

    /// <summary>The content-security policy a view runs under: inline script and style, data: images, and no network request.</summary>
    public const string ViewPolicy =
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

    // The page's base look and hangar.markdown's styles (Guide/base.css), before the view's own.
    private static readonly Lazy<string> BaseStyle = new(() => Resource("base.css"));

    private static readonly Regex LeadingDoctype = new(@"^\s*<!doctype[^>]*>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// A view as the frame gets it: the policy, the base style and the bridge first, then the view's own
    /// document. They go before the view's own <c>&lt;html&gt;</c> — the parser opens the head for them and
    /// folds the view's head into it — so nothing in the view runs before the policy is in force. The
    /// view's doctype is moved in front of them, keeping the page out of quirks mode.
    /// </summary>
    public static string Compose(string view)
    {
        var body = LeadingDoctype.Replace(view, "");
        return "<!doctype html>" +
               $"<meta http-equiv=\"Content-Security-Policy\" content=\"{ViewPolicy}\">" +
               "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
               $"<style>{BaseStyle.Value}</style>" +
               $"<script>{Bridge.Value}</script>" +
               body;
    }
}
