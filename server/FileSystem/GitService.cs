using System.Diagnostics;
using System.Text;

namespace ClaudeWeb.Server.FileSystem;

public sealed record GitStatus(bool IsRepo, string? Branch, Dictionary<string, string> Files);

public sealed record GitDiff(bool IsRepo, string Path, string Status, string Diff);

public sealed record GitCommit(string Hash, string ShortHash, string Subject, string Author, string Date, string RelativeDate, string Refs);

public sealed record GitLog(bool IsRepo, IReadOnlyList<GitCommit> Commits, bool HasMore);

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
        var porcelain = Run(workingDir, out _, "status", "--porcelain", "--untracked-files=all");
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

    /// <summary>Commit history, newest first. Requests one extra commit to detect whether more remain.</summary>
    public static GitLog Log(string workingDir, int skip, int count)
    {
        if (!IsRepo(workingDir)) return new GitLog(false, Array.Empty<GitCommit>(), false);

        // \x1f (unit separator) between fields, one commit per line (%s is a single line).
        // %D lists ref names (branches/tags) pointing at the commit — empty for most.
        const string fmt = "%H\x1f%h\x1f%s\x1f%an\x1f%ad\x1f%ar\x1f%D";
        var raw = Run(workingDir, out _, "log", "--no-color", $"--format={fmt}",
            "--date=short", $"--skip={skip}", $"-n{count + 1}");

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
