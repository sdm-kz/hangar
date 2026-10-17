using System.Runtime.InteropServices;
using System.Text;

namespace ClaudeWeb.Server.Sessions;

/// <summary>How to launch the CLI: a filename plus any argument prefix (e.g. node.exe cli.js).</summary>
public sealed record ExecutableSpec(string FileName, IReadOnlyList<string> Prefix);

/// <summary>
/// Resolves the configured "claude" command to something CreateProcess can actually launch.
/// On Windows the npm shim on PATH is <c>claude.cmd</c>, which cannot be launched directly;
/// a native <c>claude.exe</c> can be.
/// </summary>
public static class ClaudeExecutableResolver
{
    public static ExecutableSpec Resolve(string configured)
    {
        var isWindows = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);

        // An explicit, existing path is used verbatim (unwrapped if it's a .cmd/.bat).
        if (Path.IsPathRooted(configured) && File.Exists(configured))
            return Wrap(configured, isWindows);

        if (!OperatingSystem.IsWindows())
            return new ExecutableSpec(SearchUnix(configured) ?? configured, Array.Empty<string>());

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
            // Prefer the real program the shim runs. The alternative — cmd.exe /c shim.cmd — puts
            // the session's whole command line through cmd's parser, and the initial prompt rides
            // that command line as an argument: cmd cuts the line at the first newline (even inside
            // quotes), expands %VAR% within it, and refuses anything past 8191 characters. All three
            // silently damage the prompt, so go around cmd.exe whenever the shim can be read.
            var direct = ResolveShimTarget(path);
            if (direct is not null) return direct;

            var comspec = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            return new ExecutableSpec(comspec, new[] { "/c", path });
        }
        return new ExecutableSpec(path, Array.Empty<string>());
    }

    /// <summary>
    /// Read an npm .cmd shim and work out the program it actually launches, so the caller can run
    /// that directly. Covers both shapes npm emits: one that calls a bundled native binary
    /// (<c>"%dp0%\...\claude.exe" %*</c>) and the classic one that calls node with a .js entry point
    /// (<c>"%_prog%" "%dp0%\...\cli.js" %*</c>). Returns null for anything else, which sends the
    /// caller back to the cmd.exe wrapper — a worse launch, but never a wrong one.
    /// </summary>
    private static ExecutableSpec? ResolveShimTarget(string shimPath)
    {
        try
        {
            var shim = Path.GetFullPath(shimPath);
            var dir = Path.GetDirectoryName(shim);
            if (dir is null) return null;

            // %dp0% is the shim's own directory; npm always sets it from %~dp0, with a trailing
            // separator. %_prog% is the launcher the classic shim picks between a bundled node.exe
            // and whatever "node" PATH resolves to — it assigns both, in if/else branches we don't
            // evaluate, so collect the candidates and prefer one that exists on disk.
            var dp0 = dir + Path.DirectorySeparatorChar;
            var progCandidates = new List<string>();
            string? invocation = null;

            foreach (var raw in File.ReadLines(shim))
            {
                var line = raw.Trim();
                var assigned = ProgAssignment(line);
                if (assigned is not null) { progCandidates.Add(assigned); continue; }
                // The line forwarding the caller's arguments is the one that runs the program.
                if (line.Contains("%*")) invocation = line;
            }
            if (invocation is null) return null;

            // Trim the shim's cmd bookkeeping ("endLocal & goto ... || title %COMSPEC% & <program>"):
            // the program is whatever follows the last top-level '&'.
            invocation = LastCommand(invocation);

            var prog = progCandidates
                .Select(c => Expand(c, dp0, null))
                .FirstOrDefault(c => c is not null && File.Exists(c))
                ?? Expand(progCandidates.LastOrDefault(), dp0, null);

            var expanded = Expand(invocation, dp0, prog);
            if (expanded is null) return null;

            var tokens = Tokenize(expanded).Where(t => t != "%*").ToList();
            if (tokens.Count == 0) return null;

            var file = NormalizeProgram(tokens[0]);
            // A shim pointing at another shim would just reintroduce cmd.exe; let the caller wrap it.
            if (file is null || Path.GetExtension(file).ToLowerInvariant() is ".cmd" or ".bat")
                return null;

            var prefix = new List<string>();
            foreach (var t in tokens.Skip(1))
            {
                if (!LooksLikePath(t)) { prefix.Add(t); continue; } // a plain flag
                // The shim's entry script. Hold it to the same bar as the program: an absolute path
                // to a file that is really there. Anything relative would be resolved against the
                // server's own directory rather than the shim's, which is not what cmd would do.
                var full = ExistingFullPath(t);
                if (full is null) return null;
                prefix.Add(full);
            }
            return new ExecutableSpec(file, prefix);
        }
        catch
        {
            // An unreadable or surprising shim is not worth failing a launch over.
            return null;
        }
    }

    /// <summary>The value of a <c>SET "_prog=..."</c> / <c>SET _prog=...</c> line, or null.</summary>
    private static string? ProgAssignment(string line)
    {
        const string set = "SET ";
        if (!line.StartsWith(set, StringComparison.OrdinalIgnoreCase)) return null;
        var body = line[set.Length..].Trim().Trim('"');
        const string name = "_prog=";
        return body.StartsWith(name, StringComparison.OrdinalIgnoreCase)
            ? body[name.Length..].Trim().Trim('"')
            : null;
    }

    /// <summary>The last '&amp;'-separated command on a line, ignoring '&amp;' inside quotes.</summary>
    private static string LastCommand(string line)
    {
        var start = 0;
        var quoted = false;
        for (var i = 0; i < line.Length; i++)
        {
            if (line[i] == '"') quoted = !quoted;
            else if (line[i] == '&' && !quoted) start = i + 1;
        }
        return line[start..].Trim();
    }

    /// <summary>
    /// Substitute the two variables an npm shim uses. Every other <c>%</c> abandons the resolution
    /// (null), because a variable we leave in place would go on to be mistaken for part of a path:
    /// older cmd-shim output writes <c>"%~dp0\..\pkg\cli.js"</c>, and normalising that collapses the
    /// <c>..</c> against the literal <c>%~dp0</c> into a real-looking path to a file that isn't
    /// there. Bailing to the cmd.exe wrapper is the only safe answer to a shim we can't read.
    /// </summary>
    private static string? Expand(string? text, string dp0, string? prog)
    {
        if (text is null) return null;
        var sb = new StringBuilder();
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] != '%') { sb.Append(text[i]); continue; }
            // "%*" — the shim forwarding its own arguments — is the one non-variable use of '%'.
            if (i + 1 < text.Length && text[i + 1] == '*') { sb.Append("%*"); i++; continue; }
            var close = text.IndexOf('%', i + 1);
            if (close < 0) return null;
            var name = text[(i + 1)..close];
            if (name.Equals("dp0", StringComparison.OrdinalIgnoreCase)) sb.Append(dp0);
            else if (name.Equals("_prog", StringComparison.OrdinalIgnoreCase) && prog is not null) sb.Append(prog);
            else return null;
            i = close;
        }
        return sb.ToString();
    }

    /// <summary>Split a command into arguments the way the C runtime does, honouring double quotes.</summary>
    private static List<string> Tokenize(string command)
    {
        var tokens = new List<string>();
        var current = new StringBuilder();
        var quoted = false;
        var any = false;
        foreach (var c in command)
        {
            if (c == '"') { quoted = !quoted; any = true; }
            else if (char.IsWhiteSpace(c) && !quoted)
            {
                if (any) { tokens.Add(current.ToString()); current.Clear(); any = false; }
            }
            else { current.Append(c); any = true; }
        }
        if (any) tokens.Add(current.ToString());
        return tokens;
    }

    /// <summary>An existing full path for the shim's program, resolving a bare name against PATH.</summary>
    private static string? NormalizeProgram(string token) =>
        LooksLikePath(token) ? ExistingFullPath(token) : SearchPathInOrder(token);

    private static bool LooksLikePath(string token) =>
        token.Contains(Path.DirectorySeparatorChar) || token.Contains(Path.AltDirectorySeparatorChar);

    /// <summary>
    /// The normalised path of an existing file, or null. Rooted only: a relative path in a shim would
    /// be resolved here against the server's working directory, which has nothing to do with the
    /// shim's. Normalising collapses the separator doubled by <c>%dp0%</c>'s trailing one.
    /// </summary>
    private static string? ExistingFullPath(string path)
    {
        if (!Path.IsPathRooted(path)) return null;
        try
        {
            var full = Path.GetFullPath(path);
            return File.Exists(full) ? full : null;
        }
        catch { return null; }
    }

    /// <summary>
    /// A bare name resolved on Linux and macOS: PATH first, then the places claude installs itself.
    /// The fallbacks are not decoration — a systemd or launchd unit starts with a PATH of little more
    /// than <c>/usr/bin:/bin</c>, which has neither the native installer's <c>~/.local/bin</c>, npm's
    /// global bin, nor Homebrew's. Null when it is nowhere, and the caller passes the name on as it was.
    /// </summary>
    [System.Runtime.Versioning.UnsupportedOSPlatform("windows")]
    private static string? SearchUnix(string name)
    {
        if (name.Contains('/'))
            return null; // a relative path: the caller's to make sense of, not ours to search for
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Concat(UnixInstallDirs(home));
        foreach (var dir in dirs)
        {
            try
            {
                var full = Path.Combine(dir, name);
                if (File.Exists(full) && (File.GetUnixFileMode(full) & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute)) != 0)
                    return full;
            }
            catch { /* a malformed PATH entry */ }
        }
        return null;
    }

    /// <summary>Where claude lands outside a login PATH.</summary>
    private static IEnumerable<string> UnixInstallDirs(string home) =>
    [
        Path.Combine(home, ".local", "bin"),            // the native installer
        Path.Combine(home, ".claude", "local"),         // `claude migrate-installer`
        Path.Combine(home, ".npm-global", "bin"),       // a user-level npm prefix
        Path.Combine(home, ".bun", "bin"),
        "/opt/homebrew/bin",                            // Homebrew on Apple silicon
        "/usr/local/bin",                               // Homebrew on Intel, and npm's default prefix
        "/home/linuxbrew/.linuxbrew/bin",
        "/snap/bin",
    ];

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
