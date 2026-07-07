using Porta.Pty;

namespace ClaudeWeb.Server.Sessions.Pty;

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
public sealed class PtySession : IDisposable
{
    private readonly IPtyConnection _conn;
    private bool _disposed;

    public int ProcessId { get; }

    /// <summary>Raw VT bytes coming FROM the child (its terminal output).</summary>
    public Stream Output => _conn.ReaderStream;

    /// <summary>Raw bytes going TO the child (its stdin).</summary>
    public Stream Input => _conn.WriterStream;

    private PtySession(IPtyConnection conn)
    {
        _conn = conn;
        ProcessId = conn.Pid;
    }

    public static PtySession Start(string fileName, IReadOnlyList<string> arguments, string workingDirectory, short cols, short rows)
    {
        var env = new Dictionary<string, string>();
        foreach (System.Collections.DictionaryEntry kv in Environment.GetEnvironmentVariables())
            env[(string)kv.Key] = kv.Value?.ToString() ?? "";

        var options = new PtyOptions
        {
            Name = "xterm-256color",
            App = fileName,
            CommandLine = arguments as string[] ?? arguments.ToArray(),
            Cwd = string.IsNullOrWhiteSpace(workingDirectory) ? Environment.CurrentDirectory : workingDirectory,
            Cols = Math.Max(1, (int)cols),
            Rows = Math.Max(1, (int)rows),
            Environment = env,
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

    /// <summary>Kill the child process tree.</summary>
    public void Kill()
    {
        try { _conn.Kill(); } catch { }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _conn.Kill(); } catch { }
    }
}
