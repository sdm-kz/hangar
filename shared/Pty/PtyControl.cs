using System.Text;
using System.Text.Json;

namespace ClaudeWeb.Pty;

/// <summary>
/// The JSON control messages carried in <see cref="PtyFrameType.Control"/> frames. One record with
/// every field rather than a type hierarchy, so an older peer silently ignores fields it doesn't
/// know: the protocol has to stay <b>additive</b>, because a new web app must be able to attach to
/// a host left running by the previous build instead of orphaning (or killing) its session.
/// </summary>
/// <remarks>
/// Client to host: <c>hello</c> · <c>resize</c> · <c>repaint</c> · <c>ping</c> · <c>watchdog</c> ·
/// <c>shutdown</c>.
/// Host to client: <c>welcome</c> · <c>pong</c> · <c>renamed</c> · <c>color</c> · <c>remoteUrl</c> ·
/// <c>state</c> · <c>exited</c>.
/// </remarks>
public sealed record PtyControl
{
    /// <summary>Discriminator; see the remarks on <see cref="PtyControl"/> for the vocabulary.</summary>
    public string Type { get; init; } = "";

    /// <summary>hello/welcome: the wire protocol version the sender speaks.</summary>
    public int Protocol { get; init; }

    /// <summary>welcome/resize: pseudoconsole size.</summary>
    public int Cols { get; init; }
    /// <summary>welcome/resize: pseudoconsole size.</summary>
    public int Rows { get; init; }

    /// <summary>
    /// welcome: the host can redraw the child's screen on request (the <c>repaint</c> control), so a
    /// viewer attaching does not have to fake a SIGWINCH by nudging the size from outside.
    ///
    /// A capability flag rather than a protocol bump on purpose. <see cref="PtyFrame.Protocol"/> is
    /// what the web app refuses to attach below, and hosts outlive the app by design — raising it
    /// would orphan every session still served by the previous build, which is the one thing the pty
    /// host exists to prevent. Absent (false) means an older host: the caller falls back to nudging.
    /// </summary>
    public bool CanRepaint { get; init; }

    /// <summary>
    /// welcome: the scrollback frame that follows is a <see cref="ScreenModel"/> snapshot — the
    /// screen as it stands — rather than a recording of the last 512 KB the child wrote.
    ///
    /// The same kind of capability flag as <see cref="CanRepaint"/>, and for the same reason: the
    /// hosts serving sessions started before this build keep running, and they can only hand over
    /// the old tape. A viewer attaching to one of those still needs the redraw that a snapshot
    /// otherwise makes unnecessary, so the web app asks for it on their behalf.
    /// </summary>
    public bool CanSnapshot { get; init; }

    /// <summary>welcome: the pid of the process attached to the pseudoconsole.</summary>
    public int ChildPid { get; init; }
    /// <summary>welcome: the child's start time, pinning the exact process against PID reuse.</summary>
    public long ChildStartTicks { get; init; }

    /// <summary>renamed: the name Claude confirmed for a <c>/rename</c>.</summary>
    public string? Name { get; init; }
    /// <summary>color: the color Claude confirmed for a <c>/color</c>.</summary>
    public string? Color { get; init; }
    /// <summary>welcome/remoteUrl: the claude.ai deep link, once the child has printed it.</summary>
    public string? RemoteUrl { get; init; }

    /// <summary>welcome/exited: whether the child is already gone.</summary>
    public bool Exited { get; init; }
    /// <summary>exited: the child's exit code.</summary>
    public int ExitCode { get; init; }

    /// <summary>shutdown: also kill the child, rather than just letting the host stand down.</summary>
    public bool Kill { get; init; }

    /// <summary>watchdog: whether the host may auto-continue this session.</summary>
    public bool Enabled { get; init; }

    /// <summary>
    /// watchdog: clear the give-up flag and the consecutive-attempt counter, so auto-recovery starts
    /// from a clean slate. Sent after a manual "Continue" from the UI.
    /// </summary>
    public bool Reset { get; init; }

    /// <summary>state: the child is emitting output.</summary>
    public bool Busy { get; init; }
    /// <summary>state: a prompt appears to be waiting on the user.</summary>
    public bool Waiting { get; init; }
    /// <summary>state: the child is compacting its conversation (auto or <c>/compact</c>).</summary>
    public bool Compacting { get; init; }
    /// <summary>state: "healthy" | "recovering" | "attention".</summary>
    public string? WatchdogStatus { get; init; }

    /// <summary>
    /// state: the child prints shell-integration marks (OSC 133), so the command fields below mean
    /// something. False for a Claude session, and for a shell started without the integration.
    /// </summary>
    public bool ShellIntegration { get; init; }
    /// <summary>state: a command is running at the shell prompt.</summary>
    public bool CommandRunning { get; init; }
    /// <summary>state: when the running or last command started, Unix ms; 0 before the first.</summary>
    public long CommandStartedAt { get; init; }
    /// <summary>state: when the last command ended, Unix ms; 0 until one has.</summary>
    public long CommandEndedAt { get; init; }
    /// <summary>state: the last command's exit code, when the shell reported one.</summary>
    public int? CommandExitCode { get; init; }
    /// <summary>
    /// state: the running command is one you type into (ssh, a REPL) and has been quiet for a while,
    /// so it is waiting on you rather than working. Its own commands print no marks to say so.
    /// </summary>
    public bool CommandWaiting { get; init; }

    /// <summary>Serialize to the UTF-8 bytes of a control frame's payload.</summary>
    public byte[] ToPayload() => Encoding.UTF8.GetBytes(JsonSerializer.Serialize(this, PtyJsonContext.Default.PtyControl));

    /// <summary>Parse a control frame's payload; null when it isn't usable JSON.</summary>
    public static PtyControl? Parse(ReadOnlySpan<byte> payload)
    {
        try { return JsonSerializer.Deserialize(payload, PtyJsonContext.Default.PtyControl); }
        catch (JsonException) { return null; }
    }
}
