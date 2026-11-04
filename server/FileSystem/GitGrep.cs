using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace Hangar.Server.FileSystem;

/// <summary>One line that names the word: where, and the line itself (cut short past a few hundred characters).</summary>
public sealed record GrepMatch(string Path, int Line, string Text);

/// <summary>What a search found. <c>Truncated</c> when it stopped at the cap rather than at the end.</summary>
public sealed record GrepResult(IReadOnlyList<GrepMatch> Matches, bool Truncated, string? Error);

/// <summary>
/// Where a name appears in the rest of a code base, for the code views' cross-file navigation: the
/// reader Ctrl+clicks a name the file in front of them does not declare, and the declaration is
/// looked for everywhere else. <c>git grep</c> does the finding — it is fast, needs no index, and
/// already knows which files are the project's (tracked, or untracked but not ignored). Telling a
/// declaration from a use is the browser's job (lib/codeNav), which already does it for one file.
/// </summary>
public static class GitGrep
{
    // A name, and only a name: the client asks about the word under the pointer, and anything else
    // here would be a pattern or an option dressed up as one.
    private static readonly Regex Word = new(@"^[\p{L}\p{N}_$]{1,128}$", RegexOptions.CultureInvariant);

    // Enough for every declaration of anything with a name worth clicking, and a page of its uses;
    // a word like "var" would otherwise stream the whole repo through the server.
    private const int MaxMatches = 1000;
    // One generated file mentioning the name on every line should not take the whole budget.
    private const int MaxPerFile = 50;
    private const int MaxText = 400;
    private static readonly TimeSpan SearchTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan FetchTimeout = TimeSpan.FromSeconds(60);

    // Pull request heads that could not be fetched lately, so a review clicked through name by name does
    // not ask the network every time — for a while, not for good: the next try may well work.
    private static readonly ConcurrentDictionary<string, DateTime> FetchFailed = new(StringComparer.OrdinalIgnoreCase);
    private static readonly TimeSpan FetchRetryAfter = TimeSpan.FromMinutes(1);

    public static bool IsWord(string? word) => !string.IsNullOrEmpty(word) && Word.IsMatch(word);

    /// <summary>
    /// The word in the files of a folder as they are on disk now: tracked ones, and new ones git has not
    /// been told about yet but would not ignore. A folder outside any repo is searched the same way, by
    /// its files minus what a .gitignore there leaves out.
    /// </summary>
    public static Task<GrepResult> WorkingTreeAsync(string root, string word, CancellationToken ct)
    {
        var inRepo = GitService.Run(root, out var code, "rev-parse", "--is-inside-work-tree").Trim() == "true" && code == 0;
        var scope = inRepo ? new[] { "--untracked" } : new[] { "--no-index", "--exclude-standard" };
        return SearchAsync(root, [.. Common, .. scope, "-e", word, "--"], null, ct);
    }

    /// <summary>
    /// The word in a repo's files as one commit has them — a pull request's head, which may well not be
    /// what is checked out. <paramref name="sha"/> must already be a commit the caller has checked
    /// belongs to the review.
    /// </summary>
    public static async Task<GrepResult> AtCommitAsync(
        string workingDir, string sha, int number, string? nameWithOwner, string word, CancellationToken ct)
    {
        var top = GitService.Run(workingDir, out var code, "rev-parse", "--show-toplevel").Trim();
        if (code != 0 || top.Length == 0)
            return Fail("This session's folder is not a git checkout, so there is nothing here to search.");

        if (!HasCommit(top, sha))
        {
            var fetchError = await FetchPullAsync(top, number, nameWithOwner, ct);
            if (!HasCommit(top, sha))
                return Fail(fetchError ?? "This pull request's commit is not in the local clone.");
        }
        // Run from the top of the repo, so paths come back as the review names them.
        return await SearchAsync(top, [.. Common, "-e", word, sha, "--"], sha + ":", ct);
    }

    // Line numbers, whole words, the word taken literally, binaries skipped, NUL-separated fields so a
    // colon in a path can't be mistaken for the line number, and paths left as they are. The settings
    // that would change the shape of a line — a column field, paths from the repo's top rather than
    // the folder searched — are pinned whatever the user's config says.
    private static readonly string[] Common =
    [
        "-c", "core.quotepath=off", "-c", "grep.column=false", "-c", "grep.fullName=false",
        "grep", "-n", "-I", "-w", "-F", "-z", "--no-color",
    ];

    private static bool HasCommit(string repo, string sha)
    {
        GitService.Run(repo, out var code, "cat-file", "-e", sha + "^{commit}");
        return code == 0;
    }

    /// <summary>
    /// Bring a pull request's head into the local clone — GitHub keeps it at refs/pull/N/head of the base
    /// repo, a fork's included — from whichever remote points at that repo. Nothing local is moved: the
    /// fetch only writes objects and FETCH_HEAD. Null on success, else why not.
    /// </summary>
    private static async Task<string?> FetchPullAsync(string repo, int number, string? nameWithOwner, CancellationToken ct)
    {
        if (nameWithOwner is null) return "This folder's remote is not on GitHub.";
        var key = $"{repo}|{nameWithOwner}|{number}";
        if (FetchFailed.TryGetValue(key, out var failedAt) && DateTime.UtcNow - failedAt < FetchRetryAfter)
            return "Could not fetch this pull request into the local clone.";

        string? remote = null;
        foreach (var name in GitService.Run(repo, out _, "remote").Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0))
        {
            var url = GitService.Run(repo, out _, "config", "--get", $"remote.{name}.url").Trim();
            if (string.Equals(GitHubService.ParseRemote(url), nameWithOwner, StringComparison.OrdinalIgnoreCase))
            {
                remote = name;
                break;
            }
        }
        if (remote is null)
            return $"No remote of this clone points at {nameWithOwner}, so the pull request can't be searched here.";

        // A request the reader walked away from throws out of here, so it is not remembered as a failure.
        var (exit, _, err) = await RunAsync(repo, FetchTimeout, ct,
            "fetch", "--no-tags", "--quiet", remote, $"refs/pull/{number}/head");
        if (exit == 0)
        {
            FetchFailed.TryRemove(key, out _);
            return null;
        }
        FetchFailed[key] = DateTime.UtcNow;
        return $"Could not fetch the pull request: {FirstLine(err) ?? "git fetch failed"}";
    }

    private static async Task<GrepResult> SearchAsync(string cwd, string[] args, string? prefix, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(SearchTimeout);
        Process? p;
        try { p = Process.Start(StartInfo(cwd, args)); }
        catch { return Fail("git is not installed on this machine."); }
        if (p is null) return Fail("Could not start git.");

        using (p)
        {
            p.StandardInput.Close();
            // A read of a pipe is not always interrupted by its token (Windows), so running out of time
            // — or the reader going away — ends git itself, which ends the read.
            using var stop = cts.Token.Register(() => Kill(p));
            var stderr = p.StandardError.ReadToEndAsync(cts.Token);
            var matches = new List<GrepMatch>();
            var perFile = new Dictionary<string, int>(StringComparer.Ordinal);
            var truncated = false;
            var early = false;
            try
            {
                while (await p.StandardOutput.ReadLineAsync(cts.Token) is { } record)
                {
                    // path \0 line \0 text — the text is the rest, NULs and all.
                    var a = record.IndexOf('\0');
                    var b = a < 0 ? -1 : record.IndexOf('\0', a + 1);
                    if (b < 0 || !int.TryParse(record.AsSpan(a + 1, b - a - 1), out var line)) continue;
                    var path = record[..a];
                    if (prefix is not null && path.StartsWith(prefix, StringComparison.Ordinal)) path = path[prefix.Length..];
                    path = path.Replace('\\', '/');

                    var seen = perFile.GetValueOrDefault(path);
                    if (seen >= MaxPerFile)
                    {
                        truncated = true;
                        continue;
                    }
                    perFile[path] = seen + 1;
                    var text = record[(b + 1)..];
                    if (text.Length > MaxText) text = text[..MaxText];
                    matches.Add(new GrepMatch(path, line, text));
                    if (matches.Count >= MaxMatches)
                    {
                        truncated = early = true;
                        break;
                    }
                }
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                truncated = early = true; // out of time: what was found so far is still an answer
            }
            ct.ThrowIfCancellationRequested();
            if (cts.IsCancellationRequested) truncated = early = true; // killed mid-read, see `stop`

            if (early)
            {
                Kill(p);
                return new GrepResult(matches, truncated, null);
            }
            // The output ran out on its own: git is done, or about to be, and its exit code is the word on
            // whether "nothing" was an answer. (Killing it here instead would report every failure as
            // nothing found: on Windows git.exe is a launcher, still running a moment after its child.)
            await p.WaitForExitAsync(CancellationToken.None);
            // 1 is git grep's "nothing found", which is an answer; anything above it is a failure.
            if (matches.Count == 0 && p.ExitCode > 1)
                return Fail(FirstLine(await SafeAsync(stderr)) ?? $"git grep failed (exit {p.ExitCode}).");
            return new GrepResult(matches, truncated, null);
        }
    }

    private static async Task<(int Exit, string Stdout, string Stderr)> RunAsync(
        string cwd, TimeSpan timeout, CancellationToken ct, params string[] args)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try
        {
            using var p = Process.Start(StartInfo(cwd, args));
            if (p is null) return (-1, "", "could not start git");
            p.StandardInput.Close();
            var stdout = p.StandardOutput.ReadToEndAsync(cts.Token);
            var stderr = p.StandardError.ReadToEndAsync(cts.Token);
            try { await p.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException)
            {
                Kill(p);
                ct.ThrowIfCancellationRequested(); // the caller's, not the clock's
                return (-1, "", "timed out");
            }
            return (p.ExitCode, await SafeAsync(stdout), await SafeAsync(stderr));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return (-1, "", ex.Message);
        }
    }

    private static void Kill(Process p)
    {
        try
        {
            if (!p.HasExited) p.Kill(true);
        }
        catch { }
    }

    private static ProcessStartInfo StartInfo(string cwd, string[] args)
    {
        var psi = new ProcessStartInfo("git")
        {
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        // Nobody is there to answer a credential prompt; fail rather than wait for one.
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";
        psi.Environment["GCM_INTERACTIVE"] = "never";
        return psi;
    }

    private static async Task<string> SafeAsync(Task<string> read)
    {
        try { return await read; }
        catch { return ""; }
    }

    private static string? FirstLine(string? text) =>
        text?.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0);

    private static GrepResult Fail(string error) => new([], false, error);
}
