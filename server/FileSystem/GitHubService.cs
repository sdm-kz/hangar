using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ClaudeWeb.Server.FileSystem;

/// <summary>Whether a folder's repo lives on GitHub, and which repo it is ("owner/name").</summary>
public sealed record GitHubRepo(bool IsGitHub, string? NameWithOwner);

/// <summary>A pull request as the list shows it — everything a row needs and nothing more.</summary>
public sealed record GitHubPull(
    int Number, string Title, string Author, string State, bool Draft,
    string HeadRefName, string BaseRefName, string Url,
    string UpdatedAt,
    int Additions, int Deletions, int ChangedFiles,
    /// <summary>The commits the two sides of the review point at, so a file can be read whole at
    /// either of them. Empty on a list row, which does not ask for them.</summary>
    string HeadRefOid = "", string BaseRefOid = "");

/// <summary><see cref="Error"/> is set when GitHub could not be asked at all — no <c>gh</c>, not
/// signed in, offline — so the popup can say why instead of reading as "this repo has no PRs".</summary>
public sealed record GitHubPullList(bool IsGitHub, string? NameWithOwner, IReadOnlyList<GitHubPull> Pulls, string? Error);

/// <summary>
/// One file of a pull request, with its own slice of the unified diff. <see cref="OldPath"/> is set
/// only for a rename or a copy. <see cref="Status"/> is a single letter of the same alphabet the
/// working-tree status uses (A/M/D/R/C), so a PR's files are coloured the way changed ones are.
/// </summary>
public sealed record GitHubPullFile(
    string Path, string? OldPath, string Status,
    int Additions, int Deletions, bool Binary, bool Truncated, string Diff);

public sealed record GitHubPullDetail(GitHubPull? Pull, string Body, IReadOnlyList<GitHubPullFile> Files, string? Error);

/// <summary>The two commits a pull request names. Read on its own, without its patch.</summary>
public sealed record GitHubPullRefs(string HeadRefOid, string BaseRefOid, string? Error);

/// <summary>One file of a pull request read whole at a commit, rather than as a diff.</summary>
public sealed record GitHubFileContent(string Path, string Ref, string Content, bool Truncated, string? Error);

/// <summary>
/// The pull requests of the repo a folder belongs to, read through the <c>gh</c> CLI. gh is what
/// makes this practical: it already holds the user's GitHub credentials and resolves the repo from
/// the folder's remotes, so nothing here needs a token of its own.
///
/// Whether the folder is a GitHub repo at all is answered from the git remote instead — locally,
/// offline, and fast enough to ask on every session open, which is what decides whether the PR
/// button is in the tab bar.
/// </summary>
public static class GitHubService
{
    // gh talks to github.com; a request can be slow in a way `git rev-parse` never is.
    private const int NetworkTimeoutMs = 45_000;
    // A single file's diff past this is not something anyone is going to read line by line, and
    // shipping it costs the browser more than it costs us. Cut it, and say so on the file.
    private const int MaxFileDiffChars = 300_000;
    // And a cap across the whole patch, because the per-file one says nothing about how many files
    // there are. A pull request that regenerates a lockfile, a vendored tree or a minified bundle is
    // ordinary on GitHub and would otherwise be held in memory here and serialized whole into one
    // response. Files past the cap still appear — with their counts, and marked truncated — so the
    // review says what changed even where it cannot show it.
    private const int MaxPatchChars = 4_000_000;
    private const int MaxPatchFiles = 600;
    // What a single gh invocation may print before we stop reading it. The caps above bound what is
    // kept and sent; this bounds what is ever held at once, which is the number that matters to a
    // process hosting every live session. Comfortably above MaxPatchChars so the budget above is
    // what normally does the cutting, and splitting a patch costs a few times its own size.
    private const int MaxStdoutChars = 12_000_000;
    // A file read whole, rather than as the handful of hunks that changed in it. Larger than the
    // per-file diff cap because this is the file, not a slice of it — and still a cap, because the
    // repo on the other end is not ours and "how big is this file" is not our question to guess.
    private const int MaxFileChars = 1_500_000;
    private const int MaxPulls = 100;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// The GitHub repo a folder's <c>origin</c> — or, failing that, its first remote — points at.
    /// Parsed rather than asked of gh: this runs on every session open, and the answer is sitting in
    /// <c>.git/config</c>, so no process needs to touch the network to give it.
    /// </summary>
    public static GitHubRepo Repo(string workingDir)
    {
        var url = Git(workingDir, "config", "--get", "remote.origin.url").Trim();
        if (url.Length == 0)
        {
            // No origin: take whichever remote is first, so a fork checked out with only "upstream"
            // still finds its pull requests.
            var first = Git(workingDir, "remote").Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0);
            if (!string.IsNullOrEmpty(first)) url = Git(workingDir, "config", "--get", $"remote.{first}.url").Trim();
        }
        var repo = ParseRemote(url);
        return new GitHubRepo(repo is not null, repo);
    }

    /// <summary>
    /// "owner/name" out of a remote URL on GitHub, or null for anything else. Covers the three shapes
    /// a clone actually arrives in — https, ssh, and the scp-like <c>git@host:owner/name</c> — and
    /// accepts GitHub Enterprise hosts, which are "github.<em>something</em>" by convention.
    /// </summary>
    internal static string? ParseRemote(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        var text = url.Trim();

        string host, path;
        var scp = Regex.Match(text, @"^[^@/]+@([^:/]+):(.+)$");
        if (scp.Success)
        {
            host = scp.Groups[1].Value;
            path = scp.Groups[2].Value;
        }
        else
        {
            if (!Uri.TryCreate(text, UriKind.Absolute, out var uri)) return null;
            host = uri.Host;
            path = uri.AbsolutePath;
        }

        if (!host.Equals("github.com", StringComparison.OrdinalIgnoreCase)
            && !host.StartsWith("github.", StringComparison.OrdinalIgnoreCase)) return null;

        var parts = path.Trim('/').Split('/');
        if (parts.Length < 2) return null;
        var name = parts[^1];
        if (name.EndsWith(".git", StringComparison.OrdinalIgnoreCase)) name = name[..^4];
        return name.Length == 0 ? null : $"{parts[^2]}/{name}";
    }

    /// <summary>
    /// The repo's pull requests in the given state ("open", "closed", "merged" or "all"), newest
    /// first. A folder that isn't a GitHub repo comes back empty rather than as an error — the UI
    /// asks before it knows, and "not GitHub" is an answer, not a failure.
    /// </summary>
    public static async Task<GitHubPullList> PullsAsync(string workingDir, string? state, CancellationToken ct)
    {
        var repo = Repo(workingDir);
        if (!repo.IsGitHub) return new GitHubPullList(false, null, Array.Empty<GitHubPull>(), null);

        var (ok, stdout, error) = await GhAsync(workingDir, ct,
            "pr", "list", "--state", NormalizeState(state), "--limit", MaxPulls.ToString(),
            "--json", "number,title,author,state,isDraft,updatedAt,headRefName,baseRefName,url,additions,deletions,changedFiles");
        if (!ok) return new GitHubPullList(true, repo.NameWithOwner, Array.Empty<GitHubPull>(), error);

        try
        {
            var rows = JsonSerializer.Deserialize<List<PullJson>>(stdout, Json) ?? new();
            return new GitHubPullList(true, repo.NameWithOwner, rows.Select(ToPull).ToList(), null);
        }
        catch (JsonException)
        {
            return new GitHubPullList(true, repo.NameWithOwner, Array.Empty<GitHubPull>(), "GitHub returned something we could not read.");
        }
    }

    /// <summary>
    /// One pull request with its changed files, each carrying its own slice of the diff. The two gh
    /// calls — the metadata and the patch — run together, since neither needs the other's answer.
    /// </summary>
    public static async Task<GitHubPullDetail> PullAsync(string workingDir, int number, CancellationToken ct)
    {
        if (!Repo(workingDir).IsGitHub)
            return new GitHubPullDetail(null, "", Array.Empty<GitHubPullFile>(), "This folder is not a GitHub repository.");

        var meta = GhAsync(workingDir, ct,
            "pr", "view", number.ToString(),
            "--json", "number,title,author,state,isDraft,updatedAt,headRefName,baseRefName,url,additions,deletions,changedFiles,body,headRefOid,baseRefOid");
        // No --patch: that asks for the PR's commits as a mail-formatted series, which repeats a
        // file once per commit that touched it. The plain form is the combined diff — head against
        // base, one entry per file — which is what the Files tab of a PR shows and what this draws.
        var patch = GhAsync(workingDir, ct, "pr", "diff", number.ToString());
        await Task.WhenAll(meta, patch);

        var (metaOk, metaOut, metaError) = meta.Result;
        if (!metaOk) return new GitHubPullDetail(null, "", Array.Empty<GitHubPullFile>(), metaError);

        PullJson? row;
        try { row = JsonSerializer.Deserialize<PullJson>(metaOut, Json); }
        catch (JsonException) { row = null; }
        if (row is null) return new GitHubPullDetail(null, "", Array.Empty<GitHubPullFile>(), "GitHub returned something we could not read.");

        var (patchOk, patchOut, patchError) = patch.Result;
        // The PR itself was read: show it, with the diff's failure attached, rather than nothing.
        return new GitHubPullDetail(
            ToPull(row), row.Body ?? "",
            patchOk ? SplitPatch(patchOut) : Array.Empty<GitHubPullFile>(),
            patchOk ? null : patchError);
    }

    /// <summary>
    /// Just the two commits a pull request points at. Its own call rather than a read of
    /// <see cref="PullAsync"/>, because that one downloads the whole patch — which is a great deal of
    /// work to do again when the question is only "which commit is this file's head".
    /// </summary>
    public static async Task<GitHubPullRefs> RefsAsync(string workingDir, int number, CancellationToken ct)
    {
        if (!Repo(workingDir).IsGitHub)
            return new GitHubPullRefs("", "", "This folder is not a GitHub repository.");

        var (ok, stdout, error) = await GhAsync(workingDir, ct,
            "pr", "view", number.ToString(), "--json", "headRefOid,baseRefOid");
        if (!ok) return new GitHubPullRefs("", "", error);
        try
        {
            var row = JsonSerializer.Deserialize<PullJson>(stdout, Json);
            return new GitHubPullRefs(row?.HeadRefOid ?? "", row?.BaseRefOid ?? "", null);
        }
        catch (JsonException)
        {
            return new GitHubPullRefs("", "", "GitHub returned something we could not read.");
        }
    }

    /// <summary>
    /// One file of the repo, read whole at a commit — what the review shows when someone asks for the
    /// file rather than the change to it. <paramref name="sha"/> is a commit of this repo; GitHub
    /// keeps a pull request's head commits in the base repo, so a PR from a fork is readable here too.
    /// </summary>
    public static async Task<GitHubFileContent> FileAsync(string workingDir, string path, string sha, CancellationToken ct)
    {
        var repo = Repo(workingDir);
        if (!repo.IsGitHub)
            return new GitHubFileContent(path, sha, "", false, "This folder is not a GitHub repository.");
        if (!IsCommitSha(sha))
            return new GitHubFileContent(path, sha, "", false, "That is not a commit this review points at.");

        // The path is a URL segment sequence, not one segment: the slashes separate, everything else
        // is escaped. Without this a "#" or a space in a name silently truncates the request.
        var encoded = string.Join("/", path.Split('/').Select(Uri.EscapeDataString));
        var (ok, stdout, error) = await GhAsync(workingDir, ct,
            "api", "-H", "Accept: application/vnd.github.raw",
            $"repos/{repo.NameWithOwner}/contents/{encoded}?ref={sha}");
        if (!ok) return new GitHubFileContent(path, sha, "", false, error);

        var truncated = stdout.Length > MaxFileChars;
        return new GitHubFileContent(path, sha, truncated ? "" : stdout, truncated, null);
    }

    /// <summary>A full commit sha, and nothing else — it is about to be part of a URL handed to gh.</summary>
    private static bool IsCommitSha(string? sha) =>
        !string.IsNullOrEmpty(sha) && sha.Length == 40 && sha.All(Uri.IsHexDigit);

    /// <summary>
    /// Cut a unified patch into one entry per file. Paths are read from the <c>---</c>/<c>+++</c>
    /// lines rather than the <c>diff --git</c> header: that header repeats the path twice with only a
    /// space between the halves, which stops being unambiguous the moment a path contains one.
    /// </summary>
    internal static IReadOnlyList<GitHubPullFile> SplitPatch(string patch)
    {
        var files = new List<GitHubPullFile>();
        if (string.IsNullOrWhiteSpace(patch)) return files;

        var lines = patch.Replace("\r\n", "\n").Split('\n');
        var starts = new List<int>();
        for (var i = 0; i < lines.Length; i++)
            if (lines[i].StartsWith("diff --git ", StringComparison.Ordinal)) starts.Add(i);
        if (starts.Count == 0) return files;

        // Budget for the whole patch, spent file by file. A file that finds it empty still gets its
        // entry and its counts — what it loses is its text, which is what marks it truncated.
        var budget = MaxPatchChars;
        for (var f = 0; f < starts.Count && f < MaxPatchFiles; f++)
        {
            var from = starts[f];
            var to = f + 1 < starts.Count ? starts[f + 1] : lines.Length;
            var file = ReadFile(lines.AsSpan(from, to - from), budget);
            budget -= file.Diff.Length;
            files.Add(file);
        }
        return files;
    }

    /// <param name="budget">Characters of diff text this file may still spend — see SplitPatch.</param>
    private static GitHubPullFile ReadFile(ReadOnlySpan<string> chunk, int budget)
    {
        string? oldPath = null, newPath = null, renameFrom = null, renameTo = null;
        var status = "M";
        bool binary = false, inHunks = false, truncated = false;
        int additions = 0, deletions = 0;
        var body = new StringBuilder();

        foreach (var line in chunk)
        {
            if (!inHunks)
            {
                if (line.StartsWith("@@", StringComparison.Ordinal)) inHunks = true;
                else if (line.StartsWith("new file mode", StringComparison.Ordinal)) status = "A";
                else if (line.StartsWith("deleted file mode", StringComparison.Ordinal)) status = "D";
                else if (line.StartsWith("rename from ", StringComparison.Ordinal)) { status = "R"; renameFrom = line["rename from ".Length..]; }
                else if (line.StartsWith("rename to ", StringComparison.Ordinal)) { status = "R"; renameTo = line["rename to ".Length..]; }
                else if (line.StartsWith("copy from ", StringComparison.Ordinal)) { status = "C"; renameFrom = line["copy from ".Length..]; }
                else if (line.StartsWith("copy to ", StringComparison.Ordinal)) { status = "C"; renameTo = line["copy to ".Length..]; }
                else if (line.StartsWith("--- ", StringComparison.Ordinal)) oldPath = StripPrefix(line[4..]);
                else if (line.StartsWith("+++ ", StringComparison.Ordinal)) newPath = StripPrefix(line[4..]);
                else if (line.StartsWith("Binary files ", StringComparison.Ordinal)
                      || line.StartsWith("GIT binary patch", StringComparison.Ordinal)) binary = true;
            }
            else
            {
                // "+++"/"---" can only appear in a hunk as content, so no header test is needed here.
                if (line.StartsWith("+", StringComparison.Ordinal)) additions++;
                else if (line.StartsWith("-", StringComparison.Ordinal)) deletions++;
            }

            // Measured with the line included, not before it: a minified bundle is a single line of
            // megabytes, and a check that only asks how much has been written so far lets that one
            // line through whole — the case the cap exists for.
            if (body.Length + line.Length + 1 <= Math.Min(MaxFileDiffChars, Math.Max(0, budget)))
                body.Append(line).Append('\n');
            else truncated = true;
        }

        // A pure rename records no content change at all, so it has no ---/+++ pair to read from.
        var path = newPath ?? renameTo ?? oldPath ?? renameFrom ?? PathFromHeader(chunk[0]) ?? "(unknown)";
        var previous = status is "R" or "C" ? renameFrom ?? oldPath : null;
        // Half a diff would be drawn as though it were the whole one. A file that was cut hands over
        // its counts and nothing else; the flag is what tells the review to say so.
        return new GitHubPullFile(
            path, previous, status, additions, deletions, binary, truncated,
            truncated ? "" : body.ToString());
    }

    /// <summary>Drop git's <c>a/</c> or <c>b/</c> prefix, and read <c>/dev/null</c> as no path at all.</summary>
    private static string? StripPrefix(string raw)
    {
        // The path runs to a tab where git appended a timestamp, and is quoted only when it holds a
        // control character — which GitHub's own patches, served as UTF-8, do not produce.
        var text = raw.Split('\t')[0].Trim();
        if (text is "/dev/null" or "") return null;
        if (text.Length > 1 && text[0] == '"' && text[^1] == '"') text = text[1..^1];
        return text.StartsWith("a/", StringComparison.Ordinal) || text.StartsWith("b/", StringComparison.Ordinal)
            ? text[2..]
            : text;
    }

    /// <summary>
    /// Last resort for a binary file, whose chunk carries no <c>---</c>/<c>+++</c>: read the path out
    /// of <c>diff --git a/x b/x</c>. Both halves name the same file except under a rename, and a
    /// rename always brings its own <c>rename to</c>, so the header splits down the middle.
    /// </summary>
    private static string? PathFromHeader(string header)
    {
        const string prefix = "diff --git a/";
        if (!header.StartsWith(prefix, StringComparison.Ordinal)) return null;
        var rest = header[prefix.Length..];
        var half = (rest.Length - " b/".Length) / 2;
        return half > 0 && rest.Length == half * 2 + 3 && rest.AsSpan(half, 3).SequenceEqual(" b/")
            ? rest[..half]
            : rest.Split(" b/")[0];
    }

    private static string NormalizeState(string? state) => state?.ToLowerInvariant() switch
    {
        "closed" => "closed",
        "merged" => "merged",
        "all" => "all",
        _ => "open",
    };

    private static GitHubPull ToPull(PullJson j) => new(
        j.Number, j.Title ?? "", j.Author?.Login ?? "", j.State ?? "", j.IsDraft,
        j.HeadRefName ?? "", j.BaseRefName ?? "", j.Url ?? "",
        j.UpdatedAt ?? "",
        j.Additions, j.Deletions, j.ChangedFiles,
        j.HeadRefOid ?? "", j.BaseRefOid ?? "");

    private sealed class PullJson
    {
        public int Number { get; set; }
        public string? Title { get; set; }
        public AuthorJson? Author { get; set; }
        public string? State { get; set; }
        public bool IsDraft { get; set; }
        public string? HeadRefName { get; set; }
        public string? BaseRefName { get; set; }
        public string? Url { get; set; }
        public string? UpdatedAt { get; set; }
        public int Additions { get; set; }
        public int Deletions { get; set; }
        public int ChangedFiles { get; set; }
        public string? Body { get; set; }
        public string? HeadRefOid { get; set; }
        public string? BaseRefOid { get; set; }
    }

    private sealed class AuthorJson
    {
        public string? Login { get; set; }
    }

    /// <summary>
    /// Run gh in a folder. Returns whether it succeeded, its stdout, and — when it didn't — a message
    /// fit to put in front of someone: gh's own stderr says "gh auth login" or "no default remote
    /// repository" better than anything this layer could invent.
    /// </summary>
    private static async Task<(bool Ok, string Stdout, string? Error)> GhAsync(
        string cwd, CancellationToken ct, params string[] args)
    {
        var psi = new ProcessStartInfo("gh")
        {
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        // gh pages its output when it thinks it has a terminal and mentions its own updates on
        // stderr; neither belongs in a response body.
        psi.Environment["GH_PAGER"] = "";
        psi.Environment["GH_NO_UPDATE_NOTIFIER"] = "1";
        psi.Environment["GH_PROMPT_DISABLED"] = "1";

        try
        {
            using var p = Process.Start(psi);
            if (p is null) return (false, "", "Could not start the GitHub CLI.");

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(NetworkTimeoutMs);
            // Both reads start before the wait: draining one stream at a time deadlocks as soon as
            // the other fills its pipe buffer, which a patch of any size will.
            var stdout = ReadCappedAsync(p.StandardOutput, MaxStdoutChars, timeout.Token);
            var stderr = ReadCappedAsync(p.StandardError, 64 * 1024, timeout.Token);
            try
            {
                await p.WaitForExitAsync(timeout.Token);
                await Task.WhenAll(stdout, stderr);
            }
            catch (OperationCanceledException)
            {
                try { p.Kill(true); } catch { /* already gone */ }
                // Settle the two reads before leaving. `using` disposes the process — and with it the
                // readers these tasks hold — so walking away here would both dispose a stream mid-read
                // and leave two cancelled tasks for the finalizer to report as unobserved.
                try { await Task.WhenAll(stdout, stderr); } catch { /* cancelled with the kill */ }
                ct.ThrowIfCancellationRequested(); // the caller went away — not a timeout
                return (false, "", "GitHub did not answer in time.");
            }

            if (p.ExitCode == 0) return (true, stdout.Result, null);
            var message = stderr.Result.Trim();
            return (false, "", message.Length > 0 ? FirstLines(message) : $"The GitHub CLI failed (exit {p.ExitCode}).");
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or FileNotFoundException)
        {
            return (false, "", "The GitHub CLI (gh) is not installed, or is not on this machine's PATH.");
        }
    }

    /// <summary>
    /// Read a child's output, but never more than <paramref name="max"/> characters of it. Past that
    /// the rest is drained and dropped rather than left unread: the alternative is a full pipe, and a
    /// child blocked on writing to it is a child that never exits.
    /// </summary>
    private static async Task<string> ReadCappedAsync(StreamReader reader, int max, CancellationToken ct)
    {
        var buffer = new char[16 * 1024];
        var sb = new StringBuilder();
        int read;
        while ((read = await reader.ReadAsync(buffer, ct)) > 0)
            if (sb.Length < max) sb.Append(buffer, 0, Math.Min(read, max - sb.Length));
        return sb.ToString();
    }

    /// <summary>gh's errors are short, but a failed API call can trail a stack of hints — keep the
    /// part that says what went wrong.</summary>
    private static string FirstLines(string text)
    {
        var lines = text.Split('\n').Select(l => l.TrimEnd('\r')).Where(l => l.Trim().Length > 0).Take(3);
        return string.Join(" ", lines);
    }

    /// <summary>Ask git a local question, through the one git spawner this assembly has. Empty
    /// output means git is missing or the folder is not a repo, which both read as "not GitHub".</summary>
    private static string Git(string cwd, params string[] args) => GitService.Run(cwd, out _, args);
}
