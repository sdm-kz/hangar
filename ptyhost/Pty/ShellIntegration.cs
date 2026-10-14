namespace ClaudeWeb.PtyHost.Pty;

/// <summary>
/// Follows the commands run at a shell prompt through the FinalTerm / VS Code shell-integration marks
/// (OSC 133) that the web app has the shell print: <c>A</c> as a prompt is drawn, <c>C</c> as a
/// command starts, <c>D;&lt;exit&gt;</c> as it ends. What comes out is whether a command is running,
/// and how the last one ended — for a shell tab, the same "working" and "finished" a Claude session
/// gets from its hooks.
/// </summary>
/// <remarks>
/// <para>A shell that marks only its prompt (cmd has no hook before a command runs) still gets a
/// start: Enter typed while the prompt is up counts as one, and the next prompt ends it, with no exit
/// code to give. That inference stands down for good the moment a real <c>C</c> turns up, so a shell
/// that does mark its commands is never second-guessed by the keyboard.</para>
/// <para>Not thread-safe on its own: the output side runs on the read pump under the channel's lock,
/// and the input side takes the same lock.</para>
/// </remarks>
internal sealed class ShellIntegration
{
    // Long enough for "133;D;-2147483648" and a little more; anything longer is some other OSC.
    private const int MaxPayload = 32;

    private enum Scan { Text, Esc, Osc, OscEsc, Skip, SkipEsc }

    private Scan _scan;
    private readonly char[] _payload = new char[MaxPayload];
    private int _len;

    private bool _atPrompt;
    private bool _marksCommands; // a C has been seen: never infer a start from input again

    /// <summary>Whether the shell has printed any mark at all — i.e. the integration is in place.</summary>
    public bool Seen { get; private set; }

    /// <summary>A command is running: started (marked or inferred) and not yet back at a prompt.</summary>
    public bool Running { get; private set; }

    /// <summary>When the running or last command started, in Unix milliseconds; 0 before the first.</summary>
    public long StartedAt { get; private set; }

    /// <summary>When the last command ended, in Unix milliseconds; 0 until one has.</summary>
    public long EndedAt { get; private set; }

    /// <summary>The last command's exit code, when the shell reported one.</summary>
    public int? ExitCode { get; private set; }

    /// <summary>Feed output bytes. Returns true when the command state changed.</summary>
    public bool Feed(ReadOnlySpan<byte> bytes)
    {
        var changed = false;
        foreach (var b in bytes)
        {
            switch (_scan)
            {
                case Scan.Text:
                    if (b == 0x1b) _scan = Scan.Esc;
                    break;
                case Scan.Esc:
                    if (b == (byte)']') { _scan = Scan.Osc; _len = 0; }
                    else _scan = b == 0x1b ? Scan.Esc : Scan.Text;
                    break;
                case Scan.Osc:
                    if (b == 0x07) { changed |= Mark(); _scan = Scan.Text; }
                    else if (b == 0x1b) _scan = Scan.OscEsc;
                    else if (_len < MaxPayload) _payload[_len++] = (char)b;
                    else _scan = Scan.Skip; // too long to be ours; wait out its terminator
                    break;
                case Scan.OscEsc:
                    // ESC \ is the string terminator; any other ESC aborts the OSC and starts afresh.
                    if (b == (byte)'\\') { changed |= Mark(); _scan = Scan.Text; }
                    else _scan = b == (byte)']' ? Scan.Osc : Scan.Text;
                    if (_scan == Scan.Osc) _len = 0;
                    break;
                case Scan.Skip:
                    if (b == 0x07) _scan = Scan.Text;
                    else if (b == 0x1b) _scan = Scan.SkipEsc;
                    break;
                case Scan.SkipEsc:
                    _scan = b == (byte)'\\' ? Scan.Text : Scan.Skip;
                    break;
            }
        }
        return changed;
    }

    /// <summary>
    /// Note input typed into the shell. Enter at a prompt starts a command for a shell that marks only
    /// its prompts. Returns true when the command state changed.
    /// </summary>
    public bool Input(ReadOnlySpan<byte> bytes)
    {
        if (_marksCommands || !_atPrompt || Running || bytes.IndexOf((byte)'\r') < 0) return false;
        Start();
        return true;
    }

    private bool Mark()
    {
        ReadOnlySpan<char> p = _payload.AsSpan(0, _len);
        if (!p.StartsWith("133;") || p.Length < 5) return false;
        Seen = true;
        switch (p[4])
        {
            case 'A':
                _atPrompt = true;
                // A prompt with a command still open: the shell never said how it ended (cmd, or a
                // D lost to a crash), so it ends here without an exit code.
                if (Running) { End(null); return true; }
                return false;
            case 'C':
                _marksCommands = true;
                if (Running) return false;
                Start();
                return true;
            case 'D':
                if (!Running) return false; // the first prompt's D, before anything has run
                int? code = null;
                if (p.Length > 6 && p[5] == ';' && int.TryParse(p[6..], out var c)) code = c;
                End(code);
                return true;
            default:
                return false;
        }
    }

    private void Start()
    {
        Running = true;
        _atPrompt = false;
        StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private void End(int? code)
    {
        Running = false;
        ExitCode = code;
        EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
