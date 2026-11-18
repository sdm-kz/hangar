using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Hangar.Server.Sessions;

namespace Hangar.Server.Widgets;

/// <summary>What a widget's params are filled from when they are not given: the session it is open in.</summary>
public sealed record WidgetContext(string Session, string? Branch, string Folder, string? ProjectId)
{
    public string Today => DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public object ToJson() => new { session = Session, branch = Branch, folder = Folder, today = Today };
}

/// <summary>One run of a widget's source, or what the cache holds of the last one.</summary>
public sealed record WidgetData(
    JsonElement? Data,
    DateTimeOffset? FetchedAt,
    string? Error,
    string? Stderr,
    int DurationMs,
    /// <summary>A claude source's own count of what the run cost at list price; null for a node one.</summary>
    double? CostUsd,
    /// <summary>Secrets the type needs that are not set: the source was not run.</summary>
    IReadOnlyList<string> MissingSecrets);

/// <summary>
/// Runs widget sources (docs/design/widgets.md §6) and keeps what they last returned.
/// </summary>
/// <remarks>
/// <para><b>Node.</b> <c>node &lt;run&gt;</c> in the session's folder, given <c>{ params, secrets, context }</c>
/// as JSON on stdin and expected to print the data as JSON. The environment it inherits has every
/// <c>HANGAR_*</c> variable taken out: a widget script must not be able to act as a session through
/// <c>/api/self</c>.</para>
/// <para><b>Claude.</b> A headless one-shot — <c>claude -p</c> with the prompt on stdin, no built-in
/// tools, an allowlist of MCP tools, <c>--json-schema</c> for the answer and hooks switched off —
/// run in a scratch folder with no <c>HANGAR_*</c> variables either. Without that last part the nested
/// <c>claude</c> would report its hooks as the session that opened the widget, and that session would
/// flicker idle and back on every refresh. (<c>--bare</c> skips hooks too, but takes API-key auth only.)</para>
/// <para><b>The cache.</b> Keyed by the type's source (<see cref="WidgetType.SourceKey"/>) and the
/// resolved params, so two sessions looking at the same ticket share one fetch, a widget whose source
/// is rewritten fetches afresh, and one whose view alone changed keeps its data. A run already
/// going is joined rather than started again — a claude source takes ten seconds and more, and two
/// tabs opening at once must not pay for it twice. It runs on the daemon's clock, not the request's:
/// a browser that gives up waiting still leaves a result for the next look.</para>
/// <para>Secret values are masked out of everything that leaves here — the data, stderr, errors —
/// when a script prints one by mistake. Best effort: the session writing the script could encode a
/// value past it, and is trusted with that, as it can already run anything on this machine.</para>
/// </remarks>
public sealed class WidgetRunner
{
    private const int MaxCacheEntries = 100;
    private static readonly TimeSpan MinClaudeForceGap = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan MinNodeForceGap = TimeSpan.FromSeconds(5);
    private const int MaxStdoutBytes = 2 * 1024 * 1024;
    private const int MaxStderrChars = 16 * 1024;

    private readonly WidgetSecrets _secrets;
    private readonly SessionManagerOptions _options;
    private readonly IConfiguration _config;
    private readonly ILogger<WidgetRunner> _log;
    private readonly IHostApplicationLifetime _life;
    private readonly ConcurrentDictionary<string, Entry> _cache = new(StringComparer.Ordinal);
    // At most a few of each at once: a page full of widgets opening together must not start a dozen
    // claude processes.
    private readonly SemaphoreSlim _claudeSlots = new(3);
    private readonly SemaphoreSlim _nodeSlots = new(8);

    private sealed class Entry
    {
        public WidgetData? Last;
        public Task<WidgetData>? Running;
        public DateTimeOffset Touched = DateTimeOffset.UtcNow;
    }

    public WidgetRunner(WidgetSecrets secrets, SessionManagerOptions options, IConfiguration config,
        ILogger<WidgetRunner> log, IHostApplicationLifetime life)
    {
        _secrets = secrets;
        _options = options;
        _config = config;
        _log = log;
        _life = life;
    }

    // ---- Params -------------------------------------------------------------------------------

    /// <summary>
    /// The params an instance runs with: each one given, else read from the session (<c>from</c>), else
    /// its default. A value with a <c>pattern</c> is cut down to its first match. Errors name the param.
    /// </summary>
    public static (Dictionary<string, JsonElement> Values, List<WidgetIssue> Errors) ResolveParams(
        WidgetManifest m, IReadOnlyDictionary<string, JsonElement>? given, WidgetContext ctx)
    {
        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var errors = new List<WidgetIssue>();
        given ??= new Dictionary<string, JsonElement>();

        foreach (var name in given.Keys.Where(k => m.Params.All(p => p.Name != k)))
            errors.Add(new("params", $"\"{m.Name}\" has no param \"{name}\"" +
                (m.Params.Count > 0 ? $" (it has: {string.Join(", ", m.Params.Select(p => p.Name))})" : " (it takes none)")));

        foreach (var p in m.Params)
        {
            JsonElement? v = given.TryGetValue(p.Name, out var g) && !IsBlank(g) ? g : null;
            var fromSession = false;
            if (v is null)
                foreach (var source in p.From)
                {
                    var text = source switch { "session" => ctx.Session, "branch" => ctx.Branch, "folder" => ctx.Folder, _ => null };
                    if (string.IsNullOrWhiteSpace(text)) continue;
                    var found = p.Pattern is { } pat ? MiniSchema.FirstMatch(pat, text) : text;
                    if (found is null) continue;
                    v = JsonSerializer.SerializeToElement(found);
                    fromSession = true;
                    break;
                }
            v ??= p.Default;
            if (v is null)
            {
                if (p.Required)
                    errors.Add(new("params", p.From.Count > 0
                        ? $"{p.Name}: none given, and none found in the session's {string.Join(" or ", p.From.Select(f => f == "session" ? "name" : f))}"
                        : $"{p.Name}: none given"));
                continue;
            }

            var value = v.Value;
            if (value.ValueKind == JsonValueKind.String && p.Pattern is { } cut && !fromSession)
            {
                var match = MiniSchema.FirstMatch(cut, value.GetString()!);
                if (match is null) { errors.Add(new("params", $"{p.Name}: \"{value.GetString()}\" does not match /{cut}/")); continue; }
                value = JsonSerializer.SerializeToElement(match);
            }
            // A number typed into a form, or given on a command line, arrives as text.
            if (value.ValueKind == JsonValueKind.String && p.Type is "integer" or "number"
                && double.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var num))
                value = p.Type == "integer" && num % 1 == 0 ? JsonSerializer.SerializeToElement((long)num) : JsonSerializer.SerializeToElement(num);
            if (value.ValueKind == JsonValueKind.String && p.Type == "boolean" && bool.TryParse(value.GetString(), out var b))
                value = JsonSerializer.SerializeToElement(b);

            foreach (var e in MiniSchema.Validate(p.Schema, value))
                errors.Add(new("params", $"{p.Name}{(e.Path.Length > 0 ? e.Path : "")}: {e.Message}"));
            values[p.Name] = value;
        }
        return (values, errors);
    }

    private static bool IsBlank(JsonElement e) =>
        e.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined
        || (e.ValueKind == JsonValueKind.String && string.IsNullOrWhiteSpace(e.GetString()));

    private static readonly Regex Placeholder = new(@"\{([A-Za-z][A-Za-z0-9_]*)\}", RegexOptions.CultureInvariant);

    /// <summary><c>{name}</c> in <paramref name="template"/> filled from the params, then the session's context.</summary>
    public static string Fill(string template, IReadOnlyDictionary<string, JsonElement> values, WidgetContext ctx) =>
        Placeholder.Replace(template, m => m.Groups[1].Value switch
        {
            var n when values.TryGetValue(n, out var v) => v.ValueKind == JsonValueKind.String ? v.GetString()! : v.GetRawText(),
            "session" => ctx.Session,
            "branch" => ctx.Branch ?? "",
            "folder" => ctx.Folder,
            "today" => ctx.Today,
            _ => m.Value,
        });

    /// <summary>The badge text a manifest names, read out of the data by its dot path.</summary>
    public static string? Badge(WidgetManifest m, JsonElement? data)
    {
        if (m.Badge is null || data is not { } at) return null;
        foreach (var part in m.Badge.Split('.'))
        {
            if (at.ValueKind == JsonValueKind.Object && at.TryGetProperty(part, out var next)) at = next;
            else if (at.ValueKind == JsonValueKind.Array && int.TryParse(part, out var i) && i >= 0 && i < at.GetArrayLength()) at = at[i];
            else return null;
        }
        var text = at.ValueKind switch
        {
            JsonValueKind.String => at.GetString(),
            JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => at.GetRawText(),
            JsonValueKind.Array => at.GetArrayLength().ToString(CultureInfo.InvariantCulture),
            _ => null,
        };
        return text is null ? null : text.Length > 24 ? text[..23] + "…" : text;
    }

    // ---- Running -------------------------------------------------------------------------------

    public enum Mode
    {
        /// <summary>Whatever the cache holds, at once; never runs anything.</summary>
        Cached,
        /// <summary>The cache if it is younger than the type's refresh (or, for manual, if there is any); else a run.</summary>
        IfStale,
        /// <summary>A run, joining one already going.</summary>
        Force,
    }

    /// <summary>The data for an instance of <paramref name="type"/>, by <paramref name="mode"/>.</summary>
    public async Task<WidgetData?> GetAsync(WidgetType type, IReadOnlyDictionary<string, JsonElement> values,
        WidgetContext ctx, Mode mode, CancellationToken ct)
    {
        var m = type.Manifest ?? throw new InvalidOperationException("a widget without a manifest cannot run");
        var key = CacheKey(type, values, ctx);
        var entry = _cache.GetOrAdd(key, _ => new Entry());
        entry.Touched = DateTimeOffset.UtcNow;

        if (mode == Mode.Cached) return entry.Last;
        if (entry.Last is { } last && entry.Running is not { IsCompleted: false })
        {
            var age = last.FetchedAt is { } at ? DateTimeOffset.UtcNow - at : TimeSpan.MaxValue;
            // A manual widget is fresh while it has anything to show: a failed refresh keeps the data
            // it had, and asking again on every look would only fail again.
            var fresh = mode == Mode.IfStale && (m.Refresh is not { } every ? last.Data is not null || last.Error is null : age < every);
            // A forced run this soon after the last one gets that one: a view calling refresh() in a
            // loop must not turn into one model call after another.
            var tooSoon = mode == Mode.Force && last.Error is null && age < (m.SourceKind == "claude" ? MinClaudeForceGap : MinNodeForceGap);
            if (fresh || tooSoon) return last;
        }

        Task<WidgetData> run;
        lock (entry)
        {
            // A run that has finished counts as none, whether or not anyone has cleared it yet.
            if (entry.Running is not { IsCompleted: false })
                entry.Running = Task.Run(async () =>
                {
                    var r = await RunAsync(type, values, ctx, _life.ApplicationStopping);
                    lock (entry)
                    {
                        // A failed run keeps the last good data on screen, with the error beside it.
                        entry.Last = r.Error is null || entry.Last?.Data is null ? r : entry.Last with
                        {
                            Error = r.Error, Stderr = r.Stderr, MissingSecrets = r.MissingSecrets,
                        };
                    }
                    return r;
                });
            run = entry.Running;
        }
        Trim();
        await run.WaitAsync(ct);
        return entry.Last;
    }

    /// <summary>A run straight through, for the test endpoint: its own result, and the cache updated with it when it worked.</summary>
    public async Task<WidgetData> TestAsync(WidgetType type, IReadOnlyDictionary<string, JsonElement> values,
        WidgetContext ctx, CancellationToken ct)
    {
        var r = await RunAsync(type, values, ctx, ct);
        // Only a run that worked replaces what instances show: a failed or cancelled test says so to
        // the session testing, and leaves the last good data where it was.
        if (r.Error is null)
        {
            var entry = _cache.GetOrAdd(CacheKey(type, values, ctx), _ => new Entry());
            lock (entry) entry.Last = r;
        }
        return r;
    }

    // What makes two runs the same run: the type's source as it is now (not its revision: a new view
    // alone keeps the data) and the params — plus, for a node script, everything it is handed (the
    // folder it runs in, the session's name and branch, the day, the project whose secrets it gets),
    // and for a claude one, its prompt as filled in (which can name the session or the day).
    private static string CacheKey(WidgetType type, IReadOnlyDictionary<string, JsonElement> values, WidgetContext ctx) =>
        $"{type.Key}@{type.SourceKey}|" + string.Join("&", values.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => $"{kv.Key}={kv.Value.GetRawText()}"))
        + "|" + (type.Manifest?.SourceKind == "claude"
            ? Fill(type.Manifest.Prompt ?? "", values, ctx)
            : string.Join("|", ctx.Folder, ctx.Session, ctx.Branch, ctx.Today, ctx.ProjectId));

    private void Trim()
    {
        if (_cache.Count <= MaxCacheEntries) return;
        foreach (var kv in _cache.OrderBy(kv => kv.Value.Touched).Take(_cache.Count - MaxCacheEntries))
            if (kv.Value.Running is not { IsCompleted: false }) _cache.TryRemove(kv.Key, out _);
    }

    private async Task<WidgetData> RunAsync(WidgetType type, IReadOnlyDictionary<string, JsonElement> values,
        WidgetContext ctx, CancellationToken ct)
    {
        var m = type.Manifest!;
        var started = Stopwatch.StartNew();
        try
        {
            if (m.SourceKind == "node")
            {
                var (secrets, missing) = _secrets.For(type.ProjectId ?? ctx.ProjectId, m.Secrets);
                if (missing.Count > 0)
                    return new(null, null, $"needs {string.Join(", ", missing)}, which {(missing.Count == 1 ? "is" : "are")} not set", null, 0, null, missing);
                await _nodeSlots.WaitAsync(ct);
                try { return Masked(await RunNodeAsync(type, m, values, secrets, ctx, started, ct), secrets.Values); }
                finally { _nodeSlots.Release(); }
            }
            await _claudeSlots.WaitAsync(ct);
            try { return await RunClaudeAsync(type, m, values, ctx, started, ct); }
            finally { _claudeSlots.Release(); }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return new(null, null, "cancelled", null, (int)started.ElapsedMilliseconds, null, []);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Widget {Key} failed to run", type.Key);
            return new(null, null, ex.Message, null, (int)started.ElapsedMilliseconds, null, []);
        }
    }

    private async Task<WidgetData> RunNodeAsync(WidgetType type, WidgetManifest m, IReadOnlyDictionary<string, JsonElement> values,
        Dictionary<string, string> secrets, WidgetContext ctx, Stopwatch started, CancellationToken ct)
    {
        var node = NodeRuntime.Find(_config);
        if (node.Error is not null) return new(null, null, node.Error, null, 0, null, []);

        var psi = new ProcessStartInfo(node.Path!)
        {
            WorkingDirectory = Directory.Exists(ctx.Folder) ? ctx.Folder : type.Folder,
        };
        psi.ArgumentList.Add(Path.Combine(type.Folder, m.Run.Replace('/', Path.DirectorySeparatorChar)));
        var input = JsonSerializer.Serialize(new { @params = values, secrets, context = ctx.ToJson() });
        var (exit, stdout, stderr, timedOut) = await Exec(psi, input, m.Timeout, ct);
        var ms = (int)started.ElapsedMilliseconds;

        if (timedOut) return new(null, null, $"did not finish within {m.Timeout.TotalSeconds:0}s", stderr, ms, null, []);
        if (exit != 0) return new(null, null, $"exited with code {exit}{FirstLine(stderr)}", stderr, ms, null, []);
        var text = stdout.Trim();
        if (text.Length == 0) return new(null, null, "printed nothing; it should print the data as JSON", stderr, ms, null, []);
        try
        {
            using var doc = JsonDocument.Parse(text);
            return new(doc.RootElement.Clone(), DateTimeOffset.UtcNow, null, NullIfEmpty(stderr), ms, null, []);
        }
        catch (JsonException ex)
        {
            return new(null, null, $"printed something that is not JSON ({ex.Message}): {Clip(text, 200)}", stderr, ms, null, []);
        }
    }

    private async Task<WidgetData> RunClaudeAsync(WidgetType type, WidgetManifest m, IReadOnlyDictionary<string, JsonElement> values,
        WidgetContext ctx, Stopwatch started, CancellationToken ct)
    {
        var spec = ClaudeExecutableResolver.Resolve(_options.ClaudeExecutable);
        if (spec.ThroughCmd)
            return new(null, null, "claude can only be reached through cmd.exe here, which mangles a JSON schema on the command line; " +
                                   "set Sessions:ClaudeExecutable to the claude.exe it runs", null, 0, null, []);

        var scratch = AppDataFolder.PathFor("widgets", ".run");
        Directory.CreateDirectory(scratch);
        var psi = new ProcessStartInfo(spec.FileName) { WorkingDirectory = scratch };
        foreach (var a in spec.Prefix) psi.ArgumentList.Add(a);
        psi.ArgumentList.Add("-p");
        psi.ArgumentList.Add("--model"); psi.ArgumentList.Add(m.Model);
        psi.ArgumentList.Add("--tools"); psi.ArgumentList.Add("");
        if (m.Tools.Count > 0) { psi.ArgumentList.Add("--allowedTools"); psi.ArgumentList.Add(string.Join(",", m.Tools)); }
        psi.ArgumentList.Add("--output-format"); psi.ArgumentList.Add("json");
        psi.ArgumentList.Add("--json-schema"); psi.ArgumentList.Add(m.Schema!.Value.GetRawText());
        psi.ArgumentList.Add("--settings"); psi.ArgumentList.Add("{\"disableAllHooks\":true}");
        // Explicit, so a defaultMode in the user's settings (acceptEdits, bypassPermissions) cannot widen
        // the run past its allowlist: in this mode, headless, a tool not allowed is denied, not asked.
        psi.ArgumentList.Add("--permission-mode"); psi.ArgumentList.Add("default");
        psi.ArgumentList.Add("--no-session-persistence");

        var prompt = Fill(m.Prompt!, values, ctx) +
                     "\n\nAnswer only through the structured output. Today is " + ctx.Today + ".";
        var (exit, stdout, stderr, timedOut) = await Exec(psi, prompt, m.Timeout, ct);
        var ms = (int)started.ElapsedMilliseconds;
        if (timedOut) return new(null, null, $"claude did not answer within {m.Timeout.TotalSeconds:0}s", stderr, ms, null, []);

        JsonElement result;
        try
        {
            using var doc = JsonDocument.Parse(stdout.Trim());
            result = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return new(null, null, exit != 0 ? $"claude exited with code {exit}{FirstLine(stderr)}" : $"claude answered with something that is not JSON: {Clip(stdout, 200)}",
                stderr, ms, null, []);
        }

        double? cost = result.TryGetProperty("total_cost_usd", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetDouble() : null;
        var text = result.TryGetProperty("result", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() : null;
        var denied = result.TryGetProperty("permission_denials", out var d) && d.ValueKind == JsonValueKind.Array
            ? d.EnumerateArray().Select(x => x.TryGetProperty("tool_name", out var n) ? n.GetString() : null).OfType<string>().Distinct().ToList()
            : [];
        var deniedNote = denied.Count > 0 ? $"; it tried {string.Join(", ", denied)}, which source.tools does not allow" : "";

        if (result.TryGetProperty("is_error", out var isErr) && isErr.ValueKind == JsonValueKind.True)
            return new(null, null, $"claude reported an error: {Clip(text ?? "(no message)", 300)}{deniedNote}", NullIfEmpty(stderr), ms, cost, []);
        if (result.TryGetProperty("structured_output", out var so) && so.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
            return new(so.Clone(), DateTimeOffset.UtcNow, null, NullIfEmpty(stderr), ms, cost, []);
        if (text is not null)
        {
            try
            {
                using var doc = JsonDocument.Parse(text);
                return new(doc.RootElement.Clone(), DateTimeOffset.UtcNow, null, NullIfEmpty(stderr), ms, cost, []);
            }
            catch (JsonException) { /* fall through */ }
        }
        return new(null, null, $"claude answered without the structured data{deniedNote}: {Clip(text ?? "", 300)}", NullIfEmpty(stderr), ms, cost, []);
    }

    /// <summary>Run a process with <paramref name="stdin"/>, a clean environment and a deadline; kill it at the deadline.</summary>
    private static async Task<(int Exit, string Stdout, string Stderr, bool TimedOut)> Exec(
        ProcessStartInfo psi, string stdin, TimeSpan timeout, CancellationToken ct)
    {
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        foreach (var name in psi.Environment.Keys.Where(k => k.StartsWith("HANGAR_", StringComparison.OrdinalIgnoreCase)).ToList())
            psi.Environment.Remove(name);

        using var p = Process.Start(psi) ?? throw new InvalidOperationException($"could not start {psi.FileName}");
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        var outTask = Pump(p.StandardOutput, stdout, MaxStdoutBytes);
        var errTask = Pump(p.StandardError, stderr, MaxStderrChars);

        // The deadline covers everything, writing the input included: a script that never reads its
        // stdin, handed more than a pipe holds, would otherwise block the write forever — and with it
        // every later fetch of the same data, which joins this one.
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(timeout);
        try
        {
            try
            {
                await p.StandardInput.WriteAsync(stdin.AsMemory(), deadline.Token);
                p.StandardInput.Close();
            }
            catch (IOException) { /* it exited without reading its input; what it printed says why */ }
            await p.WaitForExitAsync(deadline.Token);
            // A child it left behind can hold the pipes open past its own exit.
            await Task.WhenAll(outTask, errTask).WaitAsync(deadline.Token);
            return (p.ExitCode, stdout.ToString(), stderr.ToString(), false);
        }
        catch (OperationCanceledException)
        {
            try { p.Kill(entireProcessTree: true); } catch { /* already gone */ }
            if (ct.IsCancellationRequested) throw;
            return (-1, stdout.ToString(), stderr.ToString(), true);
        }
    }

    private static async Task Pump(StreamReader reader, StringBuilder into, int max)
    {
        var buf = new char[8192];
        int n;
        while ((n = await reader.ReadAsync(buf)) > 0)
            if (into.Length < max) into.Append(buf, 0, Math.Min(n, max - into.Length));
    }

    /// <summary>
    /// The result with every secret value taken out. The data is masked in its text and read back, so a
    /// value inside any string is caught; if masking breaks the JSON, the data is withheld instead.
    /// </summary>
    private static WidgetData Masked(WidgetData r, IEnumerable<string> secrets)
    {
        // Each value as it is, and as it reads inside a JSON string (quotes, backslashes, non-ASCII
        // escaped). Best effort, as any masking is: a script set on printing a secret can encode it.
        var values = secrets.Where(s => s.Length >= 4)
            .SelectMany(s => new[] { s, JsonSerializer.Serialize(s)[1..^1] })
            .Distinct(StringComparer.Ordinal)
            .OrderByDescending(s => s.Length)
            .ToList();
        if (values.Count == 0) return r;
        string? Mask(string? s)
        {
            if (s is null) return null;
            foreach (var v in values) s = s.Replace(v, "••••", StringComparison.Ordinal);
            return s;
        }
        var data = r.Data;
        if (data is { } d)
        {
            var raw = d.GetRawText();
            var masked = Mask(raw)!;
            if (!ReferenceEquals(raw, masked) && masked != raw)
            {
                try { using var doc = JsonDocument.Parse(masked); data = doc.RootElement.Clone(); }
                catch (JsonException) { return r with { Data = null, Error = "the output contained a secret's value and was withheld", Stderr = Mask(r.Stderr) }; }
            }
        }
        return r with { Data = data, Error = Mask(r.Error), Stderr = Mask(r.Stderr) };
    }

    private static string FirstLine(string stderr)
    {
        var line = stderr.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0);
        return line is null ? "" : ": " + Clip(line, 200);
    }

    private static string Clip(string s, int max) => s.Length <= max ? s : s[..max] + "…";

    private static string? NullIfEmpty(string s) => string.IsNullOrWhiteSpace(s) ? null : s;
}

/// <summary>Where <c>node</c> is, and whether it is new enough (20+, for built-in <c>fetch</c>).</summary>
public static class NodeRuntime
{
    public sealed record Found(string? Path, string? Version, string? Error);

    private static Found? _cached;
    private static string? _cachedFor;
    private static DateTime _cachedAt;

    public static Found Find(IConfiguration config)
    {
        var configured = config["Widgets:Node"];
        // A failure is held only for a minute, so installing Node takes effect without a restart.
        if (_cached is { } c && _cachedFor == configured && (c.Error is null || DateTime.UtcNow - _cachedAt < TimeSpan.FromMinutes(1)))
            return c;
        var found = Locate(configured);
        _cached = found;
        _cachedFor = configured;
        _cachedAt = DateTime.UtcNow;
        return found;
    }

    private static Found Locate(string? configured)
    {
        var path = !string.IsNullOrWhiteSpace(configured) ? configured : Search();
        if (path is null || (Path.IsPathRooted(path) && !File.Exists(path)))
            return new(null, null, "Node.js is not installed on this machine (or not on the daemon's PATH); node widgets need Node 20 or later. " +
                                   "Install it, or set Widgets:Node to its full path.");
        try
        {
            var psi = new ProcessStartInfo(path, "--version")
            {
                RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true,
            };
            using var p = Process.Start(psi)!;
            var version = p.StandardOutput.ReadToEnd().Trim();
            p.WaitForExit(5000);
            var major = int.TryParse(version.TrimStart('v').Split('.')[0], out var mj) ? mj : 0;
            return major >= 20
                ? new(path, version, null)
                : new(path, version, $"node widgets need Node 20 or later; {path} is {version}");
        }
        catch (Exception ex)
        {
            return new(null, null, $"could not run {path}: {ex.Message}");
        }
    }

    private static string? Search()
    {
        var names = OperatingSystem.IsWindows() ? new[] { "node.exe" } : new[] { "node" };
        var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries).ToList();
        // A daemon started by launchd or systemd gets a short PATH; these are where Node usually is anyway.
        if (!OperatingSystem.IsWindows()) dirs.AddRange(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]);
        else dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"));
        foreach (var dir in dirs)
            foreach (var n in names)
            {
                var full = Path.Combine(dir.Trim('"'), n);
                if (File.Exists(full)) return full;
            }
        return null;
    }
}
