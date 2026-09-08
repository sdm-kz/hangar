using Porta.Pty;

namespace ClaudeWeb.PtyHost.Pty;

/// <summary>
/// Launches a console program attached to a Windows <b>pseudoconsole</b> (ConPTY) via the
/// <c>Porta.Pty</c> library. The child sees a real interactive terminal — so the <c>claude</c> TUI
/// renders and detects a TTY (which it must, otherwise it falls back to non-interactive
/// <c>--print</c> mode) — while its VT input/output is piped to us through <see cref="Input"/> /
/// <see cref="Output"/> for streaming to an in-app xterm.js terminal.
///
/// (An earlier hand-rolled ConPTY interop failed to attach the child to the pseudoconsole on this
/// platform — the child inherited the parent console instead — so we delegate to the maintained,
/// pure-managed Porta.Pty implementation.)
/// </summary>
/// <remarks>
/// <para><b>This runs in the pty host, not the web app.</b> Porta.Pty puts the child in an anonymous
/// job object with <c>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE</c> and holds the only handle to it, so the
/// whole pseudoconsole tree dies with whichever process owns the connection — including on a
/// <c>TerminateProcess</c>. That is exactly the lifetime we want here: the host must not outlive its
/// child, and killing the host must still take <c>claude.exe</c> down.</para>
/// <para>Job membership is inherited, so the grandchild matters too: we launch
/// <c>cmd.exe /c claude.cmd …</c>, and the <c>claude.exe</c> underneath is in the same job. One job
/// close covers the entire tree — no separate process-tree kill is needed.</para>
/// </remarks>
public sealed class PtySession : IDisposable
{
    private readonly IPtyConnection _conn;
    private bool _disposed;

    public int ProcessId { get; }

    /// <summary>Raw VT bytes coming FROM the child (its terminal output).</summary>
    public Stream Output => _conn.ReaderStream;

    /// <summary>Raw bytes going TO the child (its stdin).</summary>
    public Stream Input => _conn.WriterStream;

    /// <summary>The child's exit code; only meaningful once it has actually exited.</summary>
    public int ExitCode
    {
        get { try { return _conn.ExitCode; } catch { return -1; } }
    }

    /// <summary>Raised when the child process ends, with its exit code.</summary>
    public event Action<int>? Exited;

    private PtySession(IPtyConnection conn)
    {
        _conn = conn;
        ProcessId = conn.Pid;
        _conn.ProcessExited += (_, e) => Exited?.Invoke(e.ExitCode);
    }

    /// <param name="verbatim">
    /// Pass <paramref name="arguments"/> as an already-quoted command line (joined with spaces)
    /// rather than letting Porta.Pty quote each one. See <c>PtySpawnRequest.VerbatimArguments</c>:
    /// <c>wsl.exe</c> parses its own command line and rejects a quoted <c>"-d"</c>.
    /// </param>
    public static PtySession Start(string fileName, IReadOnlyList<string> arguments, string workingDirectory, short cols, short rows,
        IReadOnlyDictionary<string, string> environment, bool verbatim = false)
    {
        var options = new PtyOptions
        {
            Name = "xterm-256color",
            App = fileName,
            CommandLine = arguments as string[] ?? arguments.ToArray(),
            VerbatimCommandLine = verbatim,
            Cwd = string.IsNullOrWhiteSpace(workingDirectory) ? Environment.CurrentDirectory : workingDirectory,
            Cols = Math.Max(1, (int)cols),
            Rows = Math.Max(1, (int)rows),
            Environment = new Dictionary<string, string>(environment),
        };

        // The spawn is async in Porta.Pty; this is a one-shot launch so blocking is fine.
        var conn = PtyProvider.SpawnAsync(options, CancellationToken.None).GetAwaiter().GetResult();
        return new PtySession(conn);
    }

    /// <summary>Resize the pseudoconsole (SIGWINCH-equivalent); the TUI repaints to the new size.</summary>
    public void Resize(short cols, short rows)
    {
        try { _conn.Resize(Math.Max(1, (int)cols), Math.Max(1, (int)rows)); }
        catch { /* connection already gone */ }
    }

    /// <summary>
    /// Whether the child has already ended. Asked once at startup to close the race where a child
    /// dies before anything has subscribed to <see cref="Exited"/>.
    /// </summary>
    /// <remarks>
    /// Asks the process rather than <c>IPtyConnection.WaitForExit(0)</c>, so that "we couldn't tell"
    /// can't be mistaken for "it exited": here the only way to fail is to be unable to open the pid,
    /// which genuinely does mean gone. A timeout-shaped API answering the same question would have to
    /// swallow its exceptions into one of the two answers, and guessing "exited" there would strand a
    /// healthy session.
    /// </remarks>
    public bool HasExited
    {
        get
        {
            try
            {
                using var p = System.Diagnostics.Process.GetProcessById(ProcessId);
                return p.HasExited;
            }
            catch { return true; }
        }
    }

    /// <summary>
    /// End the child and release the pseudoconsole. Closing the connection closes the job handle,
    /// which — being the last one — terminates the whole tree (see the class remarks).
    /// </summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        // Kill first so the child gets the terminate rather than racing the console teardown, then
        // dispose: that closes the HPCON, both pipes and the job handle. (The web-app version of this
        // class only ever called Kill(), leaking all of them for the app's lifetime.)
        try { _conn.Kill(); } catch { }
        try { _conn.Dispose(); } catch { }
    }
}
