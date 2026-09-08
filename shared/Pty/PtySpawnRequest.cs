using System.Text.Json;

namespace ClaudeWeb.Pty;

/// <summary>
/// Everything the web app hands a freshly launched host. Passed as a JSON file rather than a command
/// line: it carries the session's environment (including the hook token) and the user's initial
/// prompt, neither of which belongs in a command line other processes can read.
/// </summary>
public sealed record PtySpawnRequest(
    string SessionId,
    string PipeName,
    /// <summary>Where the host writes its <see cref="PtyState"/>.</summary>
    string StateFile,
    string LogFile,
    /// <summary>
    /// The program to attach to the pseudoconsole: the CLI itself for a session (claude.exe, or the
    /// launcher its npm shim names), or the chosen shell for a shell tab.
    /// </summary>
    string FileName,
    IReadOnlyList<string> Arguments,
    string WorkingDirectory,
    int Cols,
    int Rows,
    /// <summary>The child's full environment block; the host does not inherit its own.</summary>
    IReadOnlyDictionary<string, string> Environment,
    string? BuildStamp = null,
    /// <summary>
    /// Watchdog tunables, since the watchdog runs host-side. Null falls back to the defaults, which
    /// keeps an older web app able to spawn a newer host.
    /// </summary>
    WatchdogOptions? Watchdog = null,
    /// <summary>
    /// Whether the watchdog may auto-continue THIS session. The per-session opt-in, as opposed to the
    /// machine-wide <see cref="WatchdogOptions.Enabled"/> master switch; re-sent over the pipe
    /// whenever the user toggles it, and again on every re-attach so sessions.json stays authoritative.
    /// </summary>
    bool WatchdogEnabled = false,
    /// <summary>
    /// Hand the arguments to the child as a <b>verbatim</b> command line — joined with spaces,
    /// already quoted by the caller — instead of letting the pty library quote each one.
    /// <para>Load-bearing for shells. Porta.Pty quotes every argument unconditionally, which most
    /// programs shrug off (the CRT unquotes them again) but <c>wsl.exe</c> does not: it parses its
    /// own command line and reads <c>"-d"</c> as a command to run rather than as its distribution
    /// flag, so a WSL tab silently became "bash: -d: command not found". The claude launch keeps the
    /// quoted path — nothing there needs this — so an older host that ignores this field still
    /// starts sessions correctly.</para>
    /// </summary>
    bool VerbatimArguments = false);

/// <summary>Reading and writing <see cref="PtySpawnRequest"/> files.</summary>
public static class PtySpawnRequestStore
{
    public static void Write(string path, PtySpawnRequest request)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(request, PtyJsonFileContext.Default.PtySpawnRequest));
    }

    public static PtySpawnRequest? Read(string path)
    {
        try { return JsonSerializer.Deserialize(File.ReadAllText(path), PtyJsonFileContext.Default.PtySpawnRequest); }
        catch { return null; }
    }
}
