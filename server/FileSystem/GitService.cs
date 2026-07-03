using System.Diagnostics;
using System.Text;

namespace ClaudeWeb.Server.FileSystem;

public sealed record GitStatus(bool IsRepo, string? Branch, Dictionary<string, string> Files);

public sealed record GitDiff(bool IsRepo, string Path, string Status, string Diff);

/// <summary>
/// Thin wrapper over the <c>git</c> CLI for a working directory: repo detection, current branch,
/// per-file status, and per-file diffs. All commands run with the working directory as cwd.
/// </summary>
public static class GitService
{
    public static GitStatus Status(string workingDir)
    {
        if (Run(workingDir, out _, "rev-parse", "--is-inside-work-tree").Trim() != "true")
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
