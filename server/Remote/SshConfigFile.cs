using System.Text.RegularExpressions;

namespace ClaudeWeb.Server.Remote;

/// <summary>A host as the server user's <c>~/.ssh/config</c> describes it. Null = not said there.</summary>
public sealed record SshHostConfig(string Alias, string? HostName, string? User, int? Port, string? IdentityFile);

/// <summary>
/// The parts of OpenSSH's client config a file panel needs: which aliases exist (to offer them in the
/// connect dialog) and what an alias resolves to — HostName, User, Port, IdentityFile. Read fresh on
/// every call: the file is tiny, and someone who just added a host should not have to restart the app.
///
/// <para>The semantics are OpenSSH's own, cut down: every <c>Host</c> block whose patterns match
/// contributes, and the first value given for a keyword wins. <c>Include</c> is followed (relative
/// paths against <c>~/.ssh</c>, wildcards in the file name). <c>Match</c> blocks are skipped — they
/// test things this app cannot evaluate — and so is everything after them up to the next
/// <c>Host</c>, which is what keeps a conditional setting from leaking into every host.</para>
/// </summary>
public static class SshConfigFile
{
    public static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    public static string SshDir => Path.Combine(Home, ".ssh");

    private sealed record Block(string[] Patterns, List<(string Key, string Value)> Settings);

    /// <summary>The concrete aliases (no wildcards) the config names, each resolved.</summary>
    public static IReadOnlyList<SshHostConfig> Aliases()
    {
        var blocks = ReadBlocks();
        var names = blocks
            .SelectMany(b => b.Patterns)
            .Where(p => !p.StartsWith('!') && p.IndexOfAny(['*', '?']) < 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        return names.Select(n => Resolve(n, blocks)).ToList();
    }

    /// <summary>What the config says about <paramref name="host"/>; every field null when it says nothing.</summary>
    public static SshHostConfig Resolve(string host) => Resolve(host, ReadBlocks());

    /// <summary>
    /// The private keys OpenSSH would try by default, the ones that exist. Offered in the dialog's key
    /// picker, and tried in this order when a "key" connection names no file at all.
    /// </summary>
    public static IReadOnlyList<string> DefaultKeys()
    {
        string[] names = ["id_ed25519", "id_ecdsa", "id_rsa", "id_ed25519_sk", "id_ecdsa_sk", "id_dsa"];
        var found = names.Select(n => Path.Combine(SshDir, n)).Where(File.Exists).ToList();
        // Anything else in ~/.ssh with a matching .pub beside it is a key someone made on purpose.
        try
        {
            foreach (var pub in Directory.EnumerateFiles(SshDir, "*.pub"))
            {
                var key = pub[..^4];
                if (File.Exists(key) && !found.Contains(key, StringComparer.OrdinalIgnoreCase)) found.Add(key);
            }
        }
        catch { /* no ~/.ssh — nothing to offer */ }
        return found;
    }

    /// <summary>Expand the tokens OpenSSH allows in IdentityFile: ~, %d (home), %u (local user), %h, %r.</summary>
    public static string ExpandPath(string path, string? host = null, string? user = null)
    {
        var p = path.Trim().Trim('"');
        if (p == "~" || p.StartsWith("~/") || p.StartsWith("~\\")) p = Home + p[1..];
        p = p.Replace("%d", Home).Replace("%u", Environment.UserName);
        if (host is not null) p = p.Replace("%h", host);
        if (user is not null) p = p.Replace("%r", user);
        p = p.Replace("%%", "%");
        return Path.IsPathRooted(p) ? Path.GetFullPath(p) : Path.GetFullPath(Path.Combine(SshDir, p));
    }

    private static SshHostConfig Resolve(string host, List<Block> blocks)
    {
        string? hostName = null, user = null, identity = null;
        int? port = null;
        foreach (var b in blocks)
        {
            if (!Matches(b.Patterns, host)) continue;
            foreach (var (key, value) in b.Settings)
            {
                switch (key)
                {
                    case "hostname": hostName ??= value.Replace("%h", host); break;
                    case "user": user ??= value; break;
                    case "port": if (port is null && int.TryParse(value, out var n) && n is > 0 and <= 65535) port = n; break;
                    case "identityfile": identity ??= value; break;
                }
            }
        }
        if (identity is not null)
        {
            try { identity = ExpandPath(identity, hostName ?? host, user); }
            catch { identity = null; }
        }
        return new SshHostConfig(host, hostName, user, port, identity);
    }

    /// <summary>OpenSSH pattern-list matching: any positive pattern matches and no negated one does.</summary>
    private static bool Matches(string[] patterns, string host)
    {
        var hit = false;
        foreach (var raw in patterns)
        {
            var negated = raw.StartsWith('!');
            var pattern = negated ? raw[1..] : raw;
            var re = "^" + Regex.Escape(pattern).Replace(@"\*", ".*").Replace(@"\?", ".") + "$";
            if (!Regex.IsMatch(host, re, RegexOptions.IgnoreCase)) continue;
            if (negated) return false;
            hit = true;
        }
        return hit;
    }

    private static List<Block> ReadBlocks()
    {
        var blocks = new List<Block>();
        // Settings before the first Host apply to every host, as if under "Host *".
        var current = new Block(["*"], new());
        blocks.Add(current);
        Read(Path.Combine(SshDir, "config"), blocks, ref current, depth: 0);
        return blocks;
    }

    private static void Read(string file, List<Block> blocks, ref Block current, int depth)
    {
        if (depth > 8) return; // an Include loop
        string[] lines;
        try
        {
            if (!File.Exists(file)) return;
            lines = File.ReadAllLines(file);
        }
        catch { return; }

        var skipping = false; // inside a Match block
        foreach (var rawLine in lines)
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            var (key, value) = Split(line);
            if (key is null) continue;
            switch (key)
            {
                case "host":
                    skipping = false;
                    current = new Block(value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries), new());
                    blocks.Add(current);
                    break;
                case "match":
                    skipping = true;
                    break;
                case "include":
                    if (skipping) break;
                    foreach (var part in value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
                        foreach (var inc in Expand(part))
                            Read(inc, blocks, ref current, depth + 1);
                    break;
                default:
                    if (!skipping) current.Settings.Add((key, value.Trim('"')));
                    break;
            }
        }
    }

    private static IEnumerable<string> Expand(string pattern)
    {
        string full;
        try { full = ExpandPath(pattern); }
        catch { yield break; }
        var dir = Path.GetDirectoryName(full);
        var name = Path.GetFileName(full);
        if (dir is null || !Directory.Exists(dir)) yield break;
        if (name.IndexOfAny(['*', '?']) < 0)
        {
            yield return full;
            yield break;
        }
        string[] files;
        try { files = Directory.GetFiles(dir, name); }
        catch { yield break; }
        Array.Sort(files, StringComparer.Ordinal);
        foreach (var f in files) yield return f;
    }

    /// <summary>"Keyword value", "Keyword=value" or "Keyword = value", keyword folded to lower case.</summary>
    private static (string? Key, string Value) Split(string line)
    {
        var m = Regex.Match(line, @"^(\S+?)\s*(?:=\s*|\s+)(.*)$");
        return m.Success ? (m.Groups[1].Value.ToLowerInvariant(), m.Groups[2].Value.Trim()) : (null, "");
    }
}
