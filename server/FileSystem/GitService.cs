using System.Diagnostics;
using System.Text;

namespace ClaudeWeb.Server.FileSystem;

public sealed record GitStatus(bool IsRepo, string? Branch, Dictionary<string, string> Files);

public sealed record GitDiff(bool IsRepo, string Path, string Status, string Diff);

public sealed record GitFileContent(bool IsRepo, string Path, bool Exists, string Content);

public sealed record GitCommit(string Hash, string ShortHash, string Subject, string Author, string Date, string RelativeDate, string Refs);

public sealed record GitLog(bool IsRepo, IReadOnlyList<GitCommit> Commits, bool HasMore);

/// <summary>A local branch. <see cref="WorktreePath"/> is set only when the branch is checked out in
/// a <em>different</em> worktree than the session's folder (so the UI can flag it).</summary>
public sealed record GitRef(string Name, bool IsCurrent, string? WorktreePath);

public sealed record GitRefs(bool IsRepo, string? Current, IReadOnlyList<GitRef> Branches);

/// <summary>A worktree of a repo: its folder, the branch checked out there, and whether it's the
/// session's own folder.</summary>
public sealed record GitWorktree(string Path, string? Branch, bool IsCurrent);

public sealed record GitCommitFile(string Path, string Status);

public sealed record GitCommitDetail(
    bool IsRepo, string Hash, string ShortHash, string Subject, string Body,
    string Author, string AuthorEmail, string Date, string RelativeDate,
    IReadOnlyList<GitCommitFile> Files);

/// <summary>
/// Thin wrapper over the <c>git</c> CLI for a working directory: repo detection, current branch,
/// per-file status, and per-file diffs. All commands run with the working directory as cwd.
/// </summary>
public static class GitService
{
    private static bool IsRepo(string workingDir) =>
        Run(workingDir, out _, "rev-parse", "--is-inside-work-tree").Trim() == "true";

    public static GitStatus Status(string workingDir)
    {
        if (!IsRepo(workingDir))
            return new GitStatus(false, null, new(StringComparer.OrdinalIgnoreCase));

        var branch = Run(workingDir, out _, "rev-parse", "--abbrev-ref", "HEAD").Trim();
        if (branch is "HEAD" or "")
        {
            var sha = Run(workingDir, out _, "rev-parse", "--short", "HEAD").Trim();
            branch = string.IsNullOrEmpty(sha) ? "(no commits)" : $"detached @ {sha}";
        }

        var files = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        // -c core.quotepath=false: without it git C-quotes every non-ASCII path into octal escapes,
        // and those escapes become the keys this map is looked up by — so a file with a Cyrillic
        // name never matches the path the tree asked about.
        var porcelain = Run(workingDir, out _,
            "-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all");
        foreach (var raw in porcelain.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length < 4) continue;
            var xy = line[..2];
            var pathPart = line[3..];

            var arrow = pathPart.IndexOf(" -> ", StringComparison.Ordinal); // renames: "old -> new"
            if (arrow >= 0) pathPart = pathPart[(arrow + 4)..];
            pathPart = pathPart.Trim().Trim('"').Replace('\\', '/');

            files[pathPart] = MapStatus(xy);
        }
        return new GitStatus(true, branch, files);
    }

    /// <summary>
    /// Drop from the index everything under <paramref name="rel"/> that is staged as an addition —
    /// in the index, but not yet in HEAD. Meant to run right after the path has been deleted from
    /// disk: a file that was <c>git add</c>ed but never committed also lives in the index, and
    /// unlinking only the disk copy would leave a commit recording a file that isn't there.
    /// A committed file's deletion is left unstaged, the way deleting a file in any editor leaves it.
    /// The one place that isn't the whole story is a staged rename: its target counts as an addition,
    /// so dropping it leaves the old name's deletion staged — which is the honest end state, the file
    /// being gone under both names. An empty <paramref name="rel"/> does nothing — this only ever
    /// cleans up after one delete, and "everything staged in the repo" is never what that means.
    /// Returns how many staged paths git accepted.
    /// </summary>
    public static int UnstageAdditions(string workingDir, string rel)
    {
        if (string.IsNullOrEmpty(rel) || !IsRepo(workingDir)) return 0;

        // --literal-pathspecs: these paths are names, not patterns. Without it a file called
        // "a*.txt" would match — and unstage — every other staged addition beside it.
        // --relative reports the paths relative to workingDir (which may sit below the repo root),
        // so they can go straight back to git as pathspecs. --cached compares index to HEAD, so the
        // now-missing file is still listed.
        var staged = Run(workingDir, out var exit,
                "--literal-pathspecs", "diff", "--cached", "--name-only", "--relative",
                "--diff-filter=A", "-z", "--", rel.Replace('\\', '/'))
            .Split('\0', StringSplitOptions.RemoveEmptyEntries);
        if (exit != 0 || staged.Length == 0) return 0;

        // Chunked so a big folder can't outgrow the command line. git rm is all-or-nothing per call,
        // so a batch that fails anyway — a held index.lock, say — is retried a path at a time, rather
        // than letting one bad path cost the other 49.
        var dropped = 0;
        foreach (var batch in staged.Chunk(50))
        {
            if (Rm(batch)) { dropped += batch.Length; continue; }
            foreach (var one in batch) if (Rm(new[] { one })) dropped++;
        }
        return dropped;

        // --cached leaves the working tree alone (the file is already gone); --force because the
        // index copy matches neither HEAD nor the file; --ignore-unmatch so a path the session's own
        // git touched in between is a no-op instead of an error that takes the batch down with it.
        bool Rm(string[] paths)
        {
            var rm = new List<string>
            {
                "--literal-pathspecs", "rm", "--cached", "--force", "--quiet", "--ignore-unmatch", "--",
            };
            rm.AddRange(paths);
            Run(workingDir, out var rmExit, rm.ToArray());
            return rmExit == 0;
        }
    }

    public static GitDiff Diff(string workingDir, string relPath, string status)
    {
        string diff;
        if (status == "U")
            // Untracked/new: show every line as added (git returns exit 1, which is fine).
            diff = Run(workingDir, out _, "diff", "--no-color", "--no-index", "--", "/dev/null", relPath);
        else
        {
            diff = Run(workingDir, out _, "diff", "--no-color", "HEAD", "--", relPath);
            if (string.IsNullOrWhiteSpace(diff))
                diff = Run(workingDir, out _, "diff", "--no-color", "--", relPath); // fallback: worktree vs index
        }
        return new GitDiff(true, relPath, status, diff);
    }

    /// <summary>
    /// Commit history, newest first (requests one extra commit to detect whether more remain).
    /// By default it follows the folder's current HEAD; pass
    /// <paramref name="all"/> to include commits from every branch/worktree (<c>--all</c>), or
    /// <paramref name="refName"/> to view one specific branch. The repo (<c>.git</c>) is shared across
    /// worktrees, so <c>--all</c>/a branch ref surfaces history checked out in other worktrees too.
    /// </summary>
    public static GitLog Log(string workingDir, int skip, int count, string? refName = null, bool all = false)
    {
        if (!IsRepo(workingDir)) return new GitLog(false, Array.Empty<GitCommit>(), false);

        // \x1f (unit separator) between fields, one commit per line (%s is a single line).
        // %D lists ref names (branches/tags) pointing at the commit — empty for most.
        const string fmt = "%H\x1f%h\x1f%s\x1f%an\x1f%ad\x1f%ar\x1f%D";
        var args = new List<string>
        {
            "log", "--no-color", $"--format={fmt}", "--date=short", $"--skip={skip}", $"-n{count + 1}",
        };
        if (all)
        {
            // Interleave branches by date so an all-branches view reads chronologically.
            args.Add("--all");
            args.Add("--date-order");
        }
        else if (IsSafeRef(refName) && refName != "HEAD")
        {
            args.Add(refName!); // view a specific branch instead of the checked-out HEAD
        }
        var raw = Run(workingDir, out _, args.ToArray());

        var commits = new List<GitCommit>();
        foreach (var line in raw.Split('\n'))
        {
            var l = line.TrimEnd('\r');
            if (l.Length == 0) continue;
            var f = l.Split('\x1f');
            if (f.Length < 6) continue;
            commits.Add(new GitCommit(f[0], f[1], f[2], f[3], f[4], f[5], f.Length > 6 ? f[6] : ""));
        }

        var hasMore = commits.Count > count;
        if (hasMore) commits.RemoveRange(count, commits.Count - count);
        return new GitLog(true, commits, hasMore);
    }

    /// <summary>Full metadata (message, author, date) and changed files for a single commit.</summary>
    public static GitCommitDetail CommitInfo(string workingDir, string hash)
    {
        if (!IsRepo(workingDir))
            return new GitCommitDetail(false, hash, "", "", "", "", "", "", "", Array.Empty<GitCommitFile>());

        // %b (the body) can span lines, so keep it last; fields split on \x1f.
        const string fmt = "%H\x1f%h\x1f%s\x1f%an\x1f%ae\x1f%ad\x1f%ar\x1f%b";
        var meta = Run(workingDir, out _, "show", "-s", "--no-color", $"--format={fmt}", "--date=short", hash);
        var f = meta.Split('\x1f');
        string Get(int i) => i < f.Length ? f[i] : "";
        var full = Get(0).Trim();
        var body = Get(7).Trim('\r', '\n');

        var files = new List<GitCommitFile>();
        var raw = Run(workingDir, out _, "show", "--no-color", "--name-status", "--format=", "-M", hash);
        foreach (var line in raw.Split('\n'))
        {
            var l = line.TrimEnd('\r');
            if (l.Length < 2) continue;
            var parts = l.Split('\t');
            if (parts.Length < 2) continue;
            // Renames/copies come as "R100\told\tnew" — the new path is last.
            var path = parts[^1].Trim().Trim('"').Replace('\\', '/');
            files.Add(new GitCommitFile(path, MapNameStatus(parts[0])));
        }

        return new GitCommitDetail(
            true, full.Length > 0 ? full : hash, Get(1), Get(2), body,
            Get(3), Get(4), Get(5), Get(6), files);
    }

    /// <summary>Diff for a single file introduced by a commit (vs its first parent).</summary>
    public static GitDiff CommitDiff(string workingDir, string hash, string relPath)
    {
        if (!IsRepo(workingDir)) return new GitDiff(false, relPath, "", "");
        // --format= drops the commit header, leaving just the file's diff.
        var diff = Run(workingDir, out _, "show", "--no-color", "--format=", "-M", hash, "--", relPath);
        return new GitDiff(true, relPath, "", diff);
    }

    /// <summary>Full file content as of a commit (git show &lt;hash&gt;:&lt;path&gt;). Exists=false when the
    /// path isn't present at that commit (e.g. a file deleted by the commit).</summary>
    public static GitFileContent CommitFile(string workingDir, string hash, string relPath)
    {
        if (!IsRepo(workingDir)) return new GitFileContent(false, relPath, false, "");
        var spec = $"{hash}:{relPath.Replace('\\', '/')}";
        var content = Run(workingDir, out var exit, "show", spec);
        return exit == 0
            ? new GitFileContent(true, relPath, true, content)
            : new GitFileContent(true, relPath, false, "");
    }

    private static string MapNameStatus(string code)
    {
        if (code.Length == 0) return "M";
        return code[0] switch
        {
            'A' => "A",
            'D' => "D",
            'R' => "R",
            'C' => "R",
            _ => "M",
        };
    }

    private static string MapStatus(string xy)
    {
        if (xy == "??") return "U"; // untracked
        if (xy.Contains('D')) return "D";
        if (xy.Contains('R')) return "R";
        if (xy.Contains('A')) return "A";
        if (xy.Contains('M')) return "M";
        return xy.Trim();
    }

    /// <summary>
    /// Local branches of the session's repo, flagging which is currently checked out here and which
    /// are checked out in other worktrees (from <c>git worktree list</c>). Feeds the history branch
    /// picker so you can view a branch that lives in a different worktree.
    /// </summary>
    public static GitRefs Branches(string workingDir)
    {
        if (!IsRepo(workingDir)) return new GitRefs(false, null, Array.Empty<GitRef>());

        var current = Run(workingDir, out _, "rev-parse", "--abbrev-ref", "HEAD").Trim();

        // Map each checked-out branch to its worktree path, so the picker can show where it lives.
        var worktreeOf = new Dictionary<string, string>(StringComparer.Ordinal);
        string? wtPath = null;
        foreach (var line in Run(workingDir, out _, "worktree", "list", "--porcelain").Split('\n'))
        {
            var l = line.TrimEnd('\r');
            if (l.StartsWith("worktree ", StringComparison.Ordinal))
                wtPath = l["worktree ".Length..].Trim();
            else if (l.StartsWith("branch ", StringComparison.Ordinal) && wtPath is not null)
            {
                var refName = l["branch ".Length..].Trim();
                var name = refName.StartsWith("refs/heads/", StringComparison.Ordinal)
                    ? refName["refs/heads/".Length..]
                    : refName;
                worktreeOf[name] = wtPath;
            }
        }

        var branches = new List<GitRef>();
        // Newest first: sort by the branch tip's commit date, descending.
        foreach (var line in Run(workingDir, out _, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads").Split('\n'))
        {
            var name = line.TrimEnd('\r').Trim();
            if (name.Length == 0) continue;
            // Only surface a worktree path when the branch lives in a DIFFERENT worktree than this
            // folder — the current folder's own branch doesn't need a "checked out elsewhere" hint.
            string? otherWorktree = worktreeOf.TryGetValue(name, out var p) && !SamePath(p, workingDir) ? p : null;
            branches.Add(new GitRef(name, name == current, otherWorktree));
        }
        return new GitRefs(true, current, branches);
    }

    /// <summary>List the repo's worktrees (folder + checked-out branch), flagging the session's own.</summary>
    public static IReadOnlyList<GitWorktree> Worktrees(string workingDir)
    {
        if (!IsRepo(workingDir)) return Array.Empty<GitWorktree>();
        var list = new List<GitWorktree>();
        string? path = null, branch = null;

        void Flush()
        {
            if (path is not null)
            {
                var name = branch != null && branch.StartsWith("refs/heads/", StringComparison.Ordinal)
                    ? branch["refs/heads/".Length..]
                    : branch;
                list.Add(new GitWorktree(path, name, SamePath(path, workingDir)));
            }
            path = null;
            branch = null;
        }

        foreach (var line in Run(workingDir, out _, "worktree", "list", "--porcelain").Split('\n'))
        {
            var l = line.TrimEnd('\r');
            if (l.StartsWith("worktree ", StringComparison.Ordinal)) { Flush(); path = l["worktree ".Length..].Trim(); }
            else if (l.StartsWith("branch ", StringComparison.Ordinal)) branch = l["branch ".Length..].Trim();
            else if (l.Length == 0) Flush();
        }
        Flush();
        return list;
    }

    /// <summary>Validate a requested worktree folder against the session's repo: returns the working dir
    /// itself when <paramref name="dir"/> is empty, the matching worktree path when it's one of the repo's
    /// worktrees, or null otherwise (so callers can't run git against an arbitrary folder).</summary>
    public static string? ResolveWorktree(string workingDir, string? dir)
    {
        if (string.IsNullOrWhiteSpace(dir)) return workingDir;
        return Worktrees(workingDir).FirstOrDefault(w => SamePath(w.Path, dir))?.Path;
    }

    // A branch/ref token safe to hand to git as a revision: rules out option-injection ("-x") and
    // anything outside ordinary ref characters. Invalid input falls back to HEAD upstream.
    private static bool IsSafeRef(string? r) =>
        !string.IsNullOrEmpty(r) && r.Length <= 200 && r[0] != '-'
        && r.All(c => char.IsLetterOrDigit(c) || c is '.' or '_' or '/' or '-');

    private static bool SamePath(string a, string b)
    {
        try
        {
            return string.Equals(
                Path.GetFullPath(a).TrimEnd('/', '\\'),
                Path.GetFullPath(b).TrimEnd('/', '\\'),
                OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
        }
        catch { return false; }
    }

    private static string Run(string cwd, out int exitCode, params string[] args)
    {
        exitCode = -1;
        try
        {
            var psi = new ProcessStartInfo("git")
            {
                WorkingDirectory = cwd,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);

            using var p = Process.Start(psi);
            if (p is null) return "";
            var stdout = p.StandardOutput.ReadToEnd();
            _ = p.StandardError.ReadToEnd();
            if (!p.WaitForExit(10000)) { try { p.Kill(true); } catch { } }
            exitCode = p.HasExited ? p.ExitCode : -1;
            return stdout;
        }
        catch
        {
            return ""; // git not installed / not a repo — treated as "not a repo"
        }
    }
}
