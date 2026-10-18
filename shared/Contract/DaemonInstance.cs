using System.Diagnostics;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Hangar.Contract;

/// <summary>
/// How a local client — the tray today — finds and authenticates to a running daemon: a small JSON file
/// the daemon writes once it is listening and removes when it stops, at
/// <c>%LocalAppData%\Hangar\instances\&lt;port&gt;.json</c> (<c>~/.local/share/Hangar/instances</c> on
/// Linux). Keyed by port, because the port is the one thing a client already knows and two daemons can't
/// share one.
///
/// <para>The token in it is a full-access bearer token, minted per daemon run and kept nowhere else. That
/// is no wider than what the same user can already read — the stored browser tokens sit in the same
/// folder — and it avoids trusting loopback for every other process on the machine, which is what an
/// exemption in <c>TokenAuthMiddleware</c> would have done. It is the docker/kubectl pattern, and it works
/// the same everywhere: the file is created readable by this user alone — 0600 in a 0700 folder on Linux
/// and macOS, an ACL naming only this user on Windows.</para>
/// </summary>
public sealed record DaemonInstance(
    int Pid,
    int Port,
    /// <summary>
    /// Loopback base URL for API calls, taken from an address the daemon actually bound. A client sends
    /// the token nowhere else — see <see cref="HasLoopbackUrl"/>.
    /// </summary>
    string LocalUrl,
    /// <summary>Where to send a person: <c>Server:PublicUrl</c> when set, otherwise the loopback.</summary>
    string OpenUrl,
    string Token,
    /// <summary>The daemon's executable, so a client can tell which install it is talking to.</summary>
    string? ExePath,
    /// <summary>The running build (from build.json); null for a build scripts\build.ps1 didn't make.</summary>
    string? BuildId,
    /// <summary>
    /// When the daemon's process started, as the OS records it — what tells the daemon apart from a later
    /// process that has been handed the same pid.
    /// </summary>
    DateTimeOffset StartedAt)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static string Folder => AppDataFolder.PathFor("instances");

    /// <summary>
    /// The same folder under the data folder's name from before the rename, which a tray or Snap of an
    /// older build still looks in. The daemon writes its file there too until that is gone.
    /// </summary>
    private static string LegacyFolder => AppDataFolder.LegacyPathFor("instances");

    public static string PathFor(int port) => Path.Combine(Folder, $"{port}.json");

    private static string LegacyPathFor(int port) => Path.Combine(LegacyFolder, $"{port}.json");

    /// <summary>
    /// Whether <see cref="LocalUrl"/> points at this machine. A client sends the token only there: any other
    /// address would hand a full-access token to whoever answers at it.
    /// </summary>
    [JsonIgnore]
    public bool HasLoopbackUrl => Uri.TryCreate(LocalUrl, UriKind.Absolute, out var uri) && uri.IsLoopback;

    /// <summary>The instance file for a port, or null when there is none or it can't be read right now.</summary>
    /// <remarks>
    /// Looks in the folder from before the rename too, for a daemon of an older build — and takes its file
    /// over a dead one here, which a crashed run of this build can leave behind.
    /// </remarks>
    public static DaemonInstance? Read(int port)
    {
        var current = Read(PathFor(port));
        if (current is not null && current.ProcessAlive()) return current;
        return Read(LegacyPathFor(port)) is { } legacy && legacy.ProcessAlive() ? legacy : current;
    }

    private static DaemonInstance? Read(string path)
    {
        try
        {
            return File.Exists(path)
                ? JsonSerializer.Deserialize<DaemonInstance>(File.ReadAllText(path), Json)
                : null;
        }
        catch { return null; } // mid-replace or unreadable — a caller polling for it simply looks again
    }

    /// <summary>
    /// Whether the process that wrote this file is still running. A daemon that crashed leaves its file
    /// behind; this is how a client tells that file apart from a live one.
    /// </summary>
    public bool ProcessAlive()
    {
        try
        {
            using var p = Process.GetProcessById(Pid);
            if (p.HasExited) return false;
            // A pid is handed out again once its process is gone, so the start time is what says this is
            // still the daemon — the same check PersistedSession.ProcessStartTicks makes for a session.
            try { return Math.Abs((p.StartTime.ToUniversalTime() - StartedAt.UtcDateTime).TotalSeconds) < 2; }
            catch { return true; } // its start time can't be read: the pid is all there is to go on
        }
        catch { return false; }
    }

    /// <summary>Write the file atomically (a reader never sees half of it), readable by this user alone.</summary>
    public void Write()
    {
        Write(Folder, PathFor(Port));
        try { Write(LegacyFolder, LegacyPathFor(Port)); }
        catch { /* only an older client reads it; the file that matters is written */ }
    }

    private void Write(string folder, string path)
    {
        const UnixFileMode ownerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        if (OperatingSystem.IsWindows()) Directory.CreateDirectory(folder);
        else Directory.CreateDirectory(folder, ownerOnly | UnixFileMode.UserExecute);

        var tmp = path + ".tmp";
        File.Delete(tmp); // the permissions below are set at creation, so the file must not exist yet
        using (var stream = OperatingSystem.IsWindows()
                   ? CreateForCurrentUserOnly(tmp)
                   : new FileStream(tmp, new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, UnixCreateMode = ownerOnly }))
            JsonSerializer.Serialize(stream, this, Json);
        File.Move(tmp, path, overwrite: true); // a move keeps the file's own ACL
    }

    /// <summary>
    /// Create a file whose ACL names the current user alone, instead of inheriting the folder's. The ACL
    /// %LocalAppData% passes down is usually little more than that, but not always — a local group can be
    /// granted read access to the whole profile — and this file is a key to the daemon. Set at creation,
    /// so the token never sits under the inherited ACL even for a moment.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static FileStream CreateForCurrentUserOnly(string path)
    {
        var acl = new FileSecurity();
        acl.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        acl.AddAccessRule(new FileSystemAccessRule(
            WindowsIdentity.GetCurrent().User!, FileSystemRights.FullControl, AccessControlType.Allow));
        return new FileInfo(path).Create(FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, acl);
    }

    /// <summary>
    /// Remove the file — but only while it is still <paramref name="pid"/>'s, so a daemon that is slow to
    /// go down can't delete the file its replacement has just written.
    /// </summary>
    public static void Delete(int port, int pid)
    {
        foreach (var path in new[] { PathFor(port), LegacyPathFor(port) })
        {
            try
            {
                if (Read(path) is { } current && current.Pid != pid) continue;
                File.Delete(path);
            }
            catch { /* best effort — a leftover file is recognised by its dead pid */ }
        }
    }
}
