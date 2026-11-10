using System.Formats.Tar;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Hangar.Server.Update;

/// <summary>What the last look at GitHub's releases came to, for the UI.</summary>
/// <param name="Repo">The repository looked at (Update:Repo).</param>
/// <param name="CheckedAtUtc">When it last answered; null before the first look has.</param>
/// <param name="Latest">The newest release there for this machine, staged or not.</param>
/// <param name="Error">Why the last look failed, if it did.</param>
public sealed record ReleaseCheck(string Repo, DateTime? CheckedAtUtc, string? Latest, string? Error);

/// <summary>
/// The other way an update gets staged: for a build made from a release, a newer release on GitHub.
/// Every few hours this asks GitHub for the repository's releases, and when one is newer than the
/// running build it downloads this machine's archive, checks it against the release's SHA256SUMS,
/// signed by the release key (see <see cref="SignedBy"/>), and stages what is in its publish folder
/// exactly as stage-update does — into
/// <c>&lt;StagingPath&gt;/payload</c>, by way of payload.tmp. From there <see cref="UpdateService"/>
/// takes over unchanged: the Update button, the dialog, the hand-off to apply-update.
///
/// The release's text is the "what's new": its bullet lines are the changes, the first other line the
/// summary, and when several releases came out since the running one, their changes together, newest
/// first. That text is the draft the release workflow writes and whoever publishes it edits.
///
/// A build made from a checkout carries no version, and under Update:Source=auto it never looks: what
/// it gets is what stage-update or a deploy puts there. Nor does a release overwrite a build someone
/// staged that way and hasn't installed yet.
/// </summary>
public sealed partial class GitHubReleaseSource : BackgroundService
{
    // Long enough for the app to settle after a start (an update's restart included), short enough that
    // a release out since the last start shows up the same morning.
    private static readonly TimeSpan FirstCheckAfter = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan ApiTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan DownloadTimeout = TimeSpan.FromMinutes(20);
    // A "check now" this soon after the last look answers with that look: an unauthenticated caller has
    // 60 requests an hour from GitHub, shared by everything behind the same address.
    private static readonly TimeSpan MinCheckGap = TimeSpan.FromMinutes(1);

    /// <summary>
    /// Where a release is downloaded and unpacked: inside the staging folder, so that the move into the
    /// payload is a rename on one volume, under the same lock-down. The updater's watcher ignores it.
    /// </summary>
    internal const string WorkFolder = "release.tmp";

    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    [GeneratedRegex(@"^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$")]
    private static partial Regex RepoPattern();

    private readonly UpdateOptions _options;
    private readonly UpdateService _updates;
    private readonly ILogger<GitHubReleaseSource> _log;
    private readonly CancellationToken _stopping;
    private readonly string? _rid = Rid();
    private readonly string? _releaseKey;
    private readonly SemaphoreSlim _running = new(1, 1);

    // The last answer and its ETag. A 304 saves reading the list again; it still counts against the
    // hourly limit, which GitHub waives only for a signed-in caller.
    private string? _etag;
    private List<Release>? _releases;
    private DateTime? _checkedAt;
    // What was found to be staged, so a look that finds the same again says nothing in the log.
    private string? _lastLogged;
    // Releases downloaded and found older than the running build (see StageAsync): not fetched again.
    private readonly HashSet<string> _older = new(StringComparer.Ordinal);

    public GitHubReleaseSource(UpdateOptions options, UpdateService updates, IHostApplicationLifetime lifetime,
        ILogger<GitHubReleaseSource> log)
    {
        _options = options;
        _updates = updates;
        _stopping = lifetime.ApplicationStopping;
        _log = log;
        _releaseKey = string.IsNullOrWhiteSpace(options.ReleaseKey) ? BuiltInReleaseKey() : options.ReleaseKey;
    }

    private string Mode => (_options.Source ?? "auto").Trim().ToLowerInvariant();

    /// <summary>Whether this build looks for releases at all (Update:Enabled, Update:Source, Update:Repo).</summary>
    public bool Active =>
        _options.Enabled
        && _rid is not null
        && _releaseKey is not null
        && RepoPattern().IsMatch(_options.Repo ?? "")
        && Mode switch
        {
            "github" => true,
            "auto" => _updates.Current?.Version is not null,
            _ => false,
        };

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!Active)
        {
            if (_options.Enabled && Mode is "auto" or "github")
                _log.LogDebug("Not looking for releases: {Why}.",
                    _rid is null ? "no release is built for this platform"
                    : _releaseKey is null ? "this build has no release key to check a release with"
                    : !RepoPattern().IsMatch(_options.Repo ?? "") ? $"Update:Repo '{_options.Repo}' is not owner/name"
                    : "this build was not made from a release");
            return;
        }

        _log.LogInformation("Looking for releases of {Repo} every {Hours} h (running {Version}).",
            _options.Repo, Hours, _updates.Current?.Version ?? _updates.Current?.BuildId ?? "unknown");
        _updates.ReportReleases(new ReleaseCheck(_options.Repo, null, null, null));
        try { await Task.Delay(FirstCheckAfter, ct); }
        catch (OperationCanceledException) { return; }

        var interval = TimeSpan.FromHours(Hours);
        while (!ct.IsCancellationRequested)
        {
            await CheckAsync(manual: false, ct);
            try { await Task.Delay(interval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private double Hours => Math.Max(1, _options.CheckHours);

    /// <summary>
    /// Look now rather than at the next interval. The look, a download included, runs for as long as the
    /// app does: <paramref name="waitFor"/> (the request's) only ends the waiting, so a proxy that gives
    /// up on a slow answer, or a closed tab, doesn't throw away a download half done.
    /// </summary>
    public Task CheckNowAsync(CancellationToken waitFor) => CheckAsync(manual: true, _stopping).WaitAsync(waitFor);

    private async Task CheckAsync(bool manual, CancellationToken ct)
    {
        // One look at a time: a "check now" during the timed one waits for it, and then takes its answer.
        await _running.WaitAsync(ct);
        try
        {
            if (manual && _checkedAt is { } last && DateTime.UtcNow - last < MinCheckGap) return;
            string? latest = null;
            try
            {
                var releases = await FetchAsync(ct);
                _checkedAt = DateTime.UtcNow;
                var usable = releases
                    .Where(r => _options.Prereleases || !r.Version.IsPrerelease)
                    .Where(r => r.Archive(_rid!) is not null && r.Asset("SHA256SUMS") is not null
                                && r.Asset("SHA256SUMS.sig") is not null)
                    .OrderByDescending(r => r.Version)
                    .ToList();
                latest = usable.FirstOrDefault()?.Version.ToString();

                var current = _updates.Current;
                var newer = usable.Where(r => IsNewer(r, current) && !_older.Contains(r.Tag)).ToList();
                if (newer.Count > 0 && ShouldStage(newer[0]))
                    await StageAsync(newer[0], Notes(newer, current), ct);
                _updates.ReportReleases(new ReleaseCheck(_options.Repo, _checkedAt, latest, null));
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _log.LogWarning("Could not look for releases of {Repo}: {Error}", _options.Repo, ex.Message);
                _updates.ReportReleases(new ReleaseCheck(_options.Repo, _checkedAt, latest, ex.Message));
            }
        }
        finally
        {
            _running.Release();
        }
    }

    /// <summary>
    /// Newer than the running build: by version when it has one; by date when it doesn't (a checkout's
    /// build under Update:Source=github), so that a release from before it was built isn't offered.
    /// </summary>
    private static bool IsNewer(Release r, BuildStamp? current)
    {
        if (ReleaseVersion.TryParse(current?.Version) is { } running) return r.Version > running;
        return current?.BuiltAtUtc is not { } built || r.PublishedAt is not { } published || published > built;
    }

    /// <summary>
    /// Whether to stage <paramref name="target"/>: not while an update is being applied, nor when it, or
    /// a later release, already is staged, nor over a build staged from a checkout (no version) that is
    /// newer than the running one and hasn't been installed yet.
    /// </summary>
    private bool ShouldStage(Release target)
    {
        var status = _updates.Status;
        var staged = status.Staged;
        var current = _updates.Current;
        string? why = null;
        if (status.State == UpdateState.Applying)
            why = "an update is being applied";
        else if (ReleaseVersion.TryParse(staged?.Version) is { } stagedVersion && stagedVersion >= target.Version)
            why = $"{stagedVersion} is already staged";
        else if (staged is not null && staged.Version is null && staged.IsNewerThan(current))
            why = $"a build staged from a checkout ({staged.BuildId}) is waiting to be installed";
        if (why is null) return true;

        var line = $"{target.Version}: {why}";
        if (line != _lastLogged) _log.LogInformation("Release {Version} found; not staging it: {Why}.", target.Version, why);
        _lastLogged = line;
        return false;
    }

    private async Task<List<Release>> FetchAsync(CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get,
            $"https://api.github.com/repos/{_options.Repo}/releases?per_page=30");
        Headers(req);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        req.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
        if (_etag is not null && _releases is not null) req.Headers.TryAddWithoutValidation("If-None-Match", _etag);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(ApiTimeout);
        using var resp = await Http.SendAsync(req, cts.Token);
        if (resp.StatusCode == HttpStatusCode.NotModified && _releases is not null) return _releases;
        if (resp.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests
            && resp.Headers.TryGetValues("x-ratelimit-remaining", out var left) && left.FirstOrDefault() == "0")
            throw new InvalidOperationException("GitHub's limit on requests from this address is spent for the hour");
        if (resp.StatusCode == HttpStatusCode.NotFound)
            throw new InvalidOperationException($"GitHub has no public repository {_options.Repo}");
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"GitHub answered {(int)resp.StatusCode} {resp.ReasonPhrase}");

        var json = await resp.Content.ReadFromJsonAsync<JsonArray>(cts.Token) ?? [];
        var releases = new List<Release>();
        foreach (var node in json)
        {
            // Drafts only reach a signed-in caller, which this isn't; skipped all the same.
            if (node?["draft"]?.GetValue<bool>() == true) continue;
            if (ReleaseVersion.TryParse((string?)node?["tag_name"]) is not { } version) continue;
            var assets = new Dictionary<string, Uri>(StringComparer.Ordinal);
            foreach (var a in node!["assets"]?.AsArray() ?? [])
                if ((string?)a?["name"] is { } name
                    && Uri.TryCreate((string?)a?["browser_download_url"], UriKind.Absolute, out var url)
                    && url.Scheme == Uri.UriSchemeHttps)
                    assets[name] = url;
            var published = DateTime.TryParse((string?)node["published_at"], null,
                System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal,
                out var at) ? at : (DateTime?)null;
            var page = Uri.TryCreate((string?)node["html_url"], UriKind.Absolute, out var html)
                       && html.Scheme == Uri.UriSchemeHttps ? html : null;
            releases.Add(new Release((string)node["tag_name"]!, version, (string?)node["body"], published, page, assets));
        }
        _etag = resp.Headers.ETag?.ToString();
        _releases = releases;
        return releases;
    }

    /// <summary>Download, verify and unpack <paramref name="release"/>, then swap it in as the staged build.</summary>
    private async Task StageAsync(Release release, ReleaseNotes? notes, CancellationToken ct)
    {
        var archiveName = release.ArchiveName(_rid!);
        var staging = _options.StagingPath;
        var work = Path.Combine(staging, WorkFolder);
        _log.LogInformation("Release {Version} is out; downloading {Archive}.", release.Version, archiveName);
        DeleteDirectory(work);
        Directory.CreateDirectory(work);
        try
        {
            // The checksums, then the signature over them: the one thing in a release its assets can't
            // forge, since the key that makes it is the release workflow's alone.
            var sums = await GetBytesAsync(release.Asset("SHA256SUMS")!, ct);
            var signature = await GetBytesAsync(release.Asset("SHA256SUMS.sig")!, ct);
            if (!SignedBy(_releaseKey!, sums, signature))
                throw new InvalidOperationException($"SHA256SUMS of {release.Tag} is not signed with the release key");
            var expected = ExpectedHash(Encoding.UTF8.GetString(sums), archiveName)
                ?? throw new InvalidOperationException($"SHA256SUMS of {release.Tag} has no line for {archiveName}");

            var archive = Path.Combine(work, archiveName);
            var actual = await DownloadAsync(release.Archive(_rid!)!, archive, ct);
            if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"{archiveName} does not match SHA256SUMS of {release.Tag}");

            var unpacked = Path.Combine(work, "x");
            Directory.CreateDirectory(unpacked);
            if (archiveName.EndsWith(".zip", StringComparison.Ordinal))
                await ZipFile.ExtractToDirectoryAsync(archive, unpacked, ct);
            else
            {
                await using var file = File.OpenRead(archive);
                await using var gz = new GZipStream(file, CompressionMode.Decompress);
                await TarFile.ExtractToDirectoryAsync(gz, unpacked, overwriteFiles: false, ct);
            }
            File.Delete(archive);

            var publish = Path.Combine(unpacked, $"hangar-{_rid}", "publish");
            if (!File.Exists(Path.Combine(publish, UpdateService.ServerExe)))
                throw new InvalidOperationException($"{archiveName} has no hangar-{_rid}/publish/{UpdateService.ServerExe}");
            StampNotes(publish, release, notes);

            // A checkout's build (Update:Source=github) was compared by the release's date, and a release
            // is published by hand, after its build: the build itself may still be the older of the two.
            var current = _updates.Current;
            if (current?.Version is null && BuildStamp.Read(publish) is { } built && !built.IsNewerThan(current))
            {
                _older.Add(release.Tag);
                _log.LogInformation("Release {Version} was built before the running build; not staging it.", release.Version);
                return;
            }

            ct.ThrowIfCancellationRequested();
            if (!_updates.Stage(() => Swap(publish, staging)))
            {
                _log.LogInformation("Release {Version} not staged: an update is being applied.", release.Version);
                return;
            }
            _lastLogged = null;
            _log.LogInformation("Release {Version} staged ({Changes} changes in its notes).",
                release.Version, notes?.Changes?.Count ?? 0);
        }
        finally
        {
            try { DeleteDirectory(work); }
            catch (Exception ex) { _log.LogDebug(ex, "Could not clear {Work}", work); }
        }
    }

    /// <summary>
    /// Put the notes into the build's own build.json, where <see cref="UpdateService"/> reads them —
    /// as stage-update does. Checks on the way that the build is the release it came with.
    /// </summary>
    private static void StampNotes(string publish, Release release, ReleaseNotes? notes)
    {
        var path = Path.Combine(publish, "build.json");
        var stamp = File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path)) as JsonObject : null;
        if (stamp is null || string.IsNullOrWhiteSpace((string?)stamp["buildId"]))
            throw new InvalidOperationException($"the build in {release.Tag} has no build.json");
        if (ReleaseVersion.TryParse((string?)stamp["version"]) is not { } built || !built.Equals(release.Version))
            throw new InvalidOperationException($"the build in {release.Tag} says it is version {(string?)stamp["version"] ?? "(none)"}");
        stamp["notes"] = notes is null ? null : JsonSerializer.SerializeToNode(notes, JsonOpts);
        stamp["releaseUrl"] = release.Page?.ToString();
        File.WriteAllText(path, stamp.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    /// <summary>
    /// The swap stage-update makes: the old payload renamed out, the new one in, the old one dropped. The
    /// app never reads a payload half there; between the renames it reads none. Its own names for the
    /// two on the side, so that a stage-update running meanwhile keeps its payload.tmp.
    /// </summary>
    private static void Swap(string publish, string staging)
    {
        var final = Path.Combine(staging, "payload");
        var tmp = Path.Combine(staging, "payload.release.tmp");
        var old = Path.Combine(staging, "payload.release.old");
        DeleteDirectory(tmp);
        Directory.Move(publish, tmp);
        DeleteDirectory(old);
        if (Directory.Exists(final)) Directory.Move(final, old);
        Directory.Move(tmp, final);
        try { DeleteDirectory(old); } catch { /* the next swap clears it */ }
    }

    /// <summary>
    /// The "what's new" of every release between the running build and the one being staged, newest
    /// first. From each release's text, the lines the release workflow writes and anyone can edit:
    /// "- " (or "* ", "+ ") lines are changes, and the newest release's first other line before them the
    /// summary; headings, HTML comments and the "Full Changelog" link are left out. A change listed by
    /// more than one release (a prerelease's, again in its release) is listed once.
    /// </summary>
    internal static ReleaseNotes? Notes(IReadOnlyList<Release> newestFirst, BuildStamp? current)
    {
        string? summary = null;
        var changes = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < newestFirst.Count; i++)
        {
            var release = newestFirst[i];
            var seenChange = false;
            foreach (var raw in (release.Body ?? "").Split('\n'))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith('#') || line.StartsWith("<!--")
                    || line.StartsWith("**Full Changelog**", StringComparison.OrdinalIgnoreCase))
                    continue;
                if (line.Length > 2 && line[0] is '-' or '*' or '+' && line[1] == ' ')
                {
                    if (seen.Add(line[2..].Trim())) changes.Add(line[2..].Trim());
                    seenChange = true;
                }
                else if (i == 0 && summary is null && !seenChange)
                    summary = line;
            }
        }
        var since = current?.Version is { } v ? "v" + v : current?.Commit;
        return new ReleaseNotes(summary, changes, since).Trimmed();
    }

    private static string? ExpectedHash(string sums, string name)
    {
        foreach (var raw in sums.Split('\n'))
        {
            // sha256sum's "<hash>  <name>", or "<hash> *<name>" in binary mode.
            var parts = raw.Trim().Split(' ', 2, StringSplitOptions.TrimEntries);
            if (parts.Length == 2 && parts[1].TrimStart('*') == name && parts[0].Length == 64) return parts[0];
        }
        return null;
    }

    /// <summary>
    /// Whether <paramref name="signature"/> is the key's over <paramref name="data"/>: ECDSA with SHA-256,
    /// DER-encoded, as <c>openssl dgst -sha256 -sign</c> writes it in the release workflow. The key checked
    /// with is the public half built into this app (server/Update/release-key.pem), or Update:ReleaseKey.
    /// </summary>
    internal static bool SignedBy(string publicKeyPem, byte[] data, byte[] signature)
    {
        using var key = ECDsa.Create();
        key.ImportFromPem(publicKeyPem);
        return key.VerifyData(data, signature, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
    }

    /// <summary>The public key embedded at build time; null in a build made without one.</summary>
    private static string? BuiltInReleaseKey()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Hangar.Server.release-key.pem");
        if (stream is null) return null;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private async Task<byte[]> GetBytesAsync(Uri url, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        Headers(req);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(ApiTimeout);
        using var resp = await Http.SendAsync(req, cts.Token);
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadAsByteArrayAsync(cts.Token);
    }

    /// <summary>Save <paramref name="url"/> to <paramref name="path"/>, hashing as it goes; returns the SHA-256 in hex.</summary>
    private async Task<string> DownloadAsync(Uri url, string path, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        Headers(req);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(DownloadTimeout);
        using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.EnsureSuccessStatusCode();
        await using var src = await resp.Content.ReadAsStreamAsync(cts.Token);
        await using var dst = File.Create(path);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];
        int n;
        while ((n = await src.ReadAsync(buffer, cts.Token)) > 0)
        {
            hash.AppendData(buffer, 0, n);
            await dst.WriteAsync(buffer.AsMemory(0, n), cts.Token);
        }
        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private void Headers(HttpRequestMessage req) =>
        // GitHub refuses a request without one.
        req.Headers.UserAgent.Add(new ProductInfoHeaderValue("Hangar", _updates.Current?.Version ?? "dev"));

    private static void DeleteDirectory(string path)
    {
        if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
    }

    /// <summary>The release archive's runtime for this process: win-x64, osx-arm64, linux-x64 and so on.</summary>
    private static string? Rid()
    {
        var os = OperatingSystem.IsWindows() ? "win"
            : OperatingSystem.IsMacOS() ? "osx"
            : OperatingSystem.IsLinux() ? "linux"
            : null;
        var arch = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "x64",
            Architecture.Arm64 => "arm64",
            _ => null,
        };
        return os is null || arch is null ? null : $"{os}-{arch}";
    }

    public override void Dispose()
    {
        _running.Dispose();
        base.Dispose();
    }

    /// <summary>One published release, as much of it as staging needs.</summary>
    internal sealed record Release(string Tag, ReleaseVersion Version, string? Body, DateTime? PublishedAt,
        Uri? Page, IReadOnlyDictionary<string, Uri> Assets)
    {
        public Uri? Asset(string name) => Assets.TryGetValue(name, out var url) ? url : null;
        public string ArchiveName(string rid) => rid.StartsWith("win-", StringComparison.Ordinal) ? $"hangar-{rid}.zip" : $"hangar-{rid}.tar.gz";
        public Uri? Archive(string rid) => Asset(ArchiveName(rid));
    }
}
