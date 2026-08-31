using System.Threading.Channels;

namespace ClaudeWeb.Server.Sessions.Pty;

/// <summary>
/// A session's live terminal, as the web app sees it: a broadcast of the child's VT output with
/// tmux-attach semantics (scrollback replay on connect, any number of concurrent viewers) plus a
/// single writer back to its stdin.
/// </summary>
/// <remarks>
/// This used to be the concrete <c>TerminalChannel</c>, which lived in this process and owned the
/// pseudoconsole — which is what made restarting the app kill every session. The implementation now
/// sits in <c>ClaudeWeb.PtyHost.exe</c> and <see cref="PtyHostClient"/> speaks to it over a named
/// pipe; keeping the shape of the old class as an interface is what let the rest of the app
/// (<see cref="ClaudeSession"/>, <see cref="TerminalSocket"/>, <see cref="SessionManager"/>) carry on
/// almost unchanged.
///
/// <para><see cref="IsBusy"/>, <see cref="IsAwaitingInput"/> and <see cref="WatchdogStatus"/> are
/// cached values the host pushes, not questions asked over the pipe: they are sampled about once a
/// second per session. The screen text they are derived from never leaves the host, which is where
/// the watchdog reads it.</para>
/// </remarks>
public interface ITerminal : IDisposable
{
    /// <summary>Attach a viewer: the current scrollback plus a live stream of everything after it.</summary>
    TerminalSubscription Subscribe();

    /// <summary>Write to the child's stdin (a keystroke, a paste, the watchdog's recovery sequence).</summary>
    ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct);

    /// <summary>Type text as if the user entered it — used to inject a <c>/rename</c>.</summary>
    void InjectInput(string text);

    /// <summary>Resize the pseudoconsole (SIGWINCH-equivalent); the TUI repaints to the new size.</summary>
    void Resize(short cols, short rows);

    /// <summary>Current pseudoconsole width.</summary>
    short Cols { get; }

    /// <summary>Current pseudoconsole height.</summary>
    short Rows { get; }

    /// <summary>True when Claude appears to be actively generating (not just echoing your typing).</summary>
    bool IsBusy { get; }

    /// <summary>True when a permission/confirmation prompt appears to be waiting on the user.</summary>
    bool IsAwaitingInput { get; }

    /// <summary>True while Claude is compacting the conversation (auto-compaction or <c>/compact</c>).</summary>
    bool IsCompacting { get; }

    /// <summary>The watchdog's view of the session: "healthy" | "recovering" | "attention".</summary>
    string WatchdogStatus { get; }

    /// <summary>The claude.ai deep link for this session, once printed; otherwise null.</summary>
    string? RemoteUrl { get; }

    /// <summary>The pid of the process attached to the pseudoconsole.</summary>
    int ProcessId { get; }

    /// <summary>Raised when Claude confirms a <c>/rename</c> in the terminal, with the new name.</summary>
    event Action<string>? RenameCommandDetected;

    /// <summary>Raised when Claude confirms a <c>/color</c> in the terminal, with the new color.</summary>
    event Action<string>? ColorCommandDetected;

    /// <summary>Raised when the session's process ends, with its exit code.</summary>
    event Action<int>? Exited;
}

/// <summary>A viewer's handle: initial <see cref="Replay"/> scrollback then a live <see cref="Reader"/>.</summary>
public sealed class TerminalSubscription(byte[] replay, ChannelReader<byte[]> reader, Action unsubscribe) : IDisposable
{
    public byte[] Replay { get; } = replay;
    public ChannelReader<byte[]> Reader { get; } = reader;
    public void Dispose() => unsubscribe();
}
