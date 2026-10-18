using System.Text.Json;

namespace Hangar.Pty;

/// <summary>
/// The on-disk marker a pty host writes for its session: enough to find the host again after the web
/// app restarts, and enough to tell a live host from a stale file. Written once the child is up,
/// stamped with an exit code when the child ends, and deleted when the host exits cleanly.
/// </summary>
/// <remarks>
/// This is <b>not</b> a second source of truth for session metadata — <c>sessions.json</c> stays
/// that. All this answers is "is that session still alive, and where do I reach it?".
/// </remarks>
public sealed record PtyState(
    string SessionId,
    int HostPid,
    /// <summary>The host's start time. PIDs are recycled, so a match only counts with this too.</summary>
    long HostStartTicks,
    string PipeName,
    int ChildPid,
    /// <summary>The child's start time; same PID-reuse guard, for the process the UI reports.</summary>
    long ChildStartTicks,
    string WorkingDirectory,
    int Protocol,
    DateTimeOffset CreatedAt,
    /// <summary>Set when the child ended, so a client that connects late can still report how.</summary>
    int? ExitCode = null,
    /// <summary>Which build published the host binary this session is running (for pruning copies).</summary>
    string? BuildStamp = null);

/// <summary>Locating, reading and writing <see cref="PtyState"/> files.</summary>
public static class PtyStateStore
{
    /// <summary>
    /// Where a given instance's state files live:
    /// <c>%LocalAppData%\Hangar\pty\&lt;instanceKey&gt;</c>. The instance key is load-bearing — the data
    /// folder is shared by every instance on the machine, so without it a dev instance would adopt (and
    /// could then stop) the live app's sessions.
    /// </summary>
    public static string Directory(string instanceKey) => AppDataFolder.PathFor("pty", Sanitize(instanceKey));

    /// <summary>
    /// The same folder under the data folder's name from before the rename. A host an older build
    /// started writes its state there for as long as it runs, so readers look in both.
    /// </summary>
    private static string LegacyDirectory(string instanceKey) => AppDataFolder.LegacyPathFor("pty", Sanitize(instanceKey));

    /// <summary>The state file a host launched now writes for one session.</summary>
    public static string PathFor(string instanceKey, string sessionId) =>
        Path.Combine(Directory(instanceKey), Sanitize(sessionId) + ".json");

    /// <summary>
    /// The state file a session's host already has: <see cref="PathFor"/>, unless only the folder from
    /// before the rename has one — the session's host was started by an older build.
    /// </summary>
    public static string Locate(string instanceKey, string sessionId)
    {
        var path = PathFor(instanceKey, sessionId);
        if (File.Exists(path)) return path;
        var legacy = Path.Combine(LegacyDirectory(instanceKey), Sanitize(sessionId) + ".json");
        return File.Exists(legacy) ? legacy : path;
    }

    /// <summary>
    /// The pipe a session's host listens on. Namespaced by instance for the same reason the state
    /// directory is.
    /// </summary>
    /// <remarks>
    /// On Linux and macOS a .NET named pipe is a Unix domain socket, and a bare name would put it at
    /// <c>$TMPDIR/CoreFxPipe_&lt;name&gt;</c>. Neither half of that holds up: a socket path is capped
    /// at 104 bytes on macOS, which a per-user <c>/var/folders/…/T/</c> plus this name overruns, and
    /// <c>/tmp</c> is swept by systemd-tmpfiles after ten days — while a session can run longer, and its
    /// socket is the only way back to it. So there the name is an absolute path (which .NET takes
    /// as-is) in a folder of the app's own, with the session part hashed down to keep it short.
    /// </remarks>
    public static string PipeName(string instanceKey, string sessionId)
    {
        var name = $"claudeweb-pty-{Sanitize(instanceKey)}-{Sanitize(sessionId)}";
        if (OperatingSystem.IsWindows()) return name;
        var hash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(name)))[..16].ToLowerInvariant();
        return Path.Combine(SocketDirectory, hash + ".sock");
    }

    /// <summary>Where the Unix sockets live: owner-only, beside the state files.</summary>
    public static string SocketDirectory => AppDataFolder.PathFor("sock");

    /// <summary>
    /// Create <see cref="SocketDirectory"/> readable by this user alone. The socket itself is checked
    /// on connect too (<c>PipeOptions.CurrentUserOnly</c>), but a folder nobody else can list keeps the
    /// session names out of view as well.
    /// </summary>
    public static void EnsureSocketDirectory()
    {
        if (OperatingSystem.IsWindows()) return;
        const UnixFileMode ownerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
        System.IO.Directory.CreateDirectory(SocketDirectory, ownerOnly);
        File.SetUnixFileMode(SocketDirectory, ownerOnly); // the mode above only applies to a folder it creates
    }

    /// <summary>Write (or overwrite) a state file, creating its directory.</summary>
    public static void Write(string path, PtyState state)
    {
        System.IO.Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        // Write-then-rename so a reader never sees a half-written file.
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(state, PtyJsonFileContext.Default.PtyState));
        File.Move(tmp, path, overwrite: true);
    }

    /// <summary>Read a state file; null when it's missing or unreadable.</summary>
    public static PtyState? Read(string path)
    {
        try
        {
            return File.Exists(path) ? JsonSerializer.Deserialize(File.ReadAllText(path), PtyJsonFileContext.Default.PtyState) : null;
        }
        catch { return null; }
    }

    /// <summary>Every state file for an instance, with the path each was read from.</summary>
    public static IEnumerable<(string Path, PtyState State)> ReadAll(string instanceKey)
    {
        foreach (var dir in new[] { Directory(instanceKey), LegacyDirectory(instanceKey) })
        {
            if (!System.IO.Directory.Exists(dir)) continue;
            foreach (var path in System.IO.Directory.EnumerateFiles(dir, "*.json"))
            {
                var state = Read(path);
                if (state is not null) yield return (path, state);
            }
        }
    }

    /// <summary>
    /// Every state file on the machine, across <b>all</b> instances. Used when a decision has to
    /// account for hosts this instance doesn't own — pruning the shared per-build copies of the host
    /// binary, where deleting a folder another instance is running from would be destructive.
    /// </summary>
    public static IEnumerable<(string Path, PtyState State)> ReadAllInstances()
    {
        var roots = new[] { AppDataFolder.PathFor("pty"), AppDataFolder.LegacyPathFor("pty") };
        foreach (var dir in roots.Where(System.IO.Directory.Exists).SelectMany(System.IO.Directory.EnumerateDirectories))
        {
            IEnumerable<string> files;
            try { files = System.IO.Directory.EnumerateFiles(dir, "*.json"); }
            catch { continue; } // another instance may be mid-write, or the folder may be locked down
            foreach (var path in files)
            {
                var state = Read(path);
                if (state is not null) yield return (path, state);
            }
        }
    }

    /// <summary>Best-effort delete; a state file we can't remove is only noise on the next scan.</summary>
    public static void Delete(string path)
    {
        try { File.Delete(path); } catch { }
    }

    /// <summary>
    /// Drop a dead (or killed) host's state file and, on Unix, its socket. A host that exits cleanly
    /// removes the socket itself; one that was killed, or went down with the machine, leaves it behind
    /// in <see cref="SocketDirectory"/>.
    /// </summary>
    public static void Forget(string path, PtyState? state)
    {
        Delete(path);
        if (!OperatingSystem.IsWindows() && state is not null && Path.IsPathRooted(state.PipeName))
            try { File.Delete(state.PipeName); } catch { }
    }

    /// <summary>
    /// Whether the host process a state file names is still the one that wrote it. The start-time
    /// check is what makes this safe: PIDs are recycled, heavily so after a reboot.
    /// </summary>
    public static bool HostAlive(PtyState state)
    {
        if (state.HostPid <= 0) return false;
        try
        {
            using var p = System.Diagnostics.Process.GetProcessById(state.HostPid);
            return !p.HasExited && (state.HostStartTicks == 0 || StartedAt(p, state.HostStartTicks));
        }
        catch { return false; } // no such process, or we can't inspect it — treat as gone
    }

    /// <summary>
    /// Whether <paramref name="p"/> started at the time recorded as <paramref name="ticks"/> (UTC) —
    /// the half of a pid-reuse check that a pid alone can't give.
    /// </summary>
    /// <remarks>
    /// Exact on Windows, where the kernel keeps a creation timestamp. Linux and macOS don't: .NET works
    /// the start time out as the boot time plus the process's age in clock ticks, and the boot time it
    /// derives moves by microseconds from one reading to the next — so the same process reads back a
    /// different value in another process, and an exact match calls every live host dead. A second's
    /// slack is far finer than pid reuse, which needs the pid space to wrap.
    /// </remarks>
    public static bool StartedAt(System.Diagnostics.Process p, long ticks)
    {
        var actual = p.StartTime.ToUniversalTime().Ticks;
        return OperatingSystem.IsWindows()
            ? actual == ticks
            : Math.Abs(actual - ticks) < TimeSpan.TicksPerSecond;
    }

    /// <summary>Keep a key usable as both a file name and a pipe name.</summary>
    private static string Sanitize(string s)
    {
        var clean = new string(s.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '-').ToArray());
        return clean.Length == 0 ? "default" : clean;
    }
}
