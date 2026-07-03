using System.Runtime.InteropServices;

namespace ClaudeWeb.Server.Sessions;

/// <summary>How to launch the CLI: a filename plus any argument prefix (e.g. cmd.exe /c script.cmd).</summary>
public sealed record ExecutableSpec(string FileName, IReadOnlyList<string> Prefix);

/// <summary>
/// Resolves the configured "claude" command to something CreateProcess can actually launch.
/// On Windows the npm shim on PATH is <c>claude.cmd</c>, which must be run via cmd.exe;
/// a native <c>claude.exe</c> can be launched directly.
/// </summary>
public static class ClaudeExecutableResolver
{
    public static ExecutableSpec Resolve(string configured)
    {
        var isWindows = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);

        // An explicit, existing path is used verbatim (wrapped if it's a .cmd/.bat).
        if (Path.IsPathRooted(configured) && File.Exists(configured))
            return Wrap(configured, isWindows);

        if (!isWindows)
            return new ExecutableSpec(configured, Array.Empty<string>());

        // Resolve like the shell would: walk PATH in order and take the FIRST directory that
        // has a launchable claude (.exe/.cmd/.bat). This matters when several claude installs
        // exist — the one earliest on PATH (typically the up-to-date npm shim) must win, rather
        // than globally preferring a possibly-stale native .exe elsewhere on PATH.
        var found = SearchPathInOrder(configured);

        return found is not null
            ? Wrap(found, isWindows)
            : new ExecutableSpec(configured, Array.Empty<string>());
    }

    private static ExecutableSpec Wrap(string path, bool isWindows)
    {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        if (isWindows && ext is ".cmd" or ".bat")
        {
            var comspec = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            return new ExecutableSpec(comspec, new[] { "/c", path });
        }
        return new ExecutableSpec(path, Array.Empty<string>());
    }

    private static readonly string[] WindowsExecExtensions = { ".exe", ".cmd", ".bat" };

    private static string? SearchPathInOrder(string name)
    {
        var hasExt = WindowsExecExtensions.Any(e => name.EndsWith(e, StringComparison.OrdinalIgnoreCase));
        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in pathVar.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var d = dir.Trim().Trim('"');
            if (d.Length == 0) continue;
            try
            {
                if (hasExt)
                {
                    var full = Path.Combine(d, name);
                    if (File.Exists(full)) return full;
                    continue;
                }
                foreach (var ext in WindowsExecExtensions)
                {
                    var full = Path.Combine(d, name + ext);
                    if (File.Exists(full)) return full;
                }
            }
            catch { }
        }
        return null;
    }
}
