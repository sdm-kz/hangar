using System.Text.RegularExpressions;

namespace ClaudeWeb.Pty;

/// <summary>
/// Minimal VT/ANSI stripping so on-screen <i>text</i> can be pattern-matched (e.g. by the watchdog).
/// This is not a terminal emulator — it just removes the escape sequences xterm.js would consume,
/// leaving the human-visible characters. Good enough for spotting an error banner in recent output.
/// </summary>
public static partial class Vt
{
    // OSC: ESC ] ... terminated by BEL (\x07) or ST (ESC \). Covers OSC-8 hyperlinks, title sets, etc.
    [GeneratedRegex(@"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")]
    private static partial Regex Osc();

    // CSI: ESC [ params intermediates final. params \x30-\x3f, intermediates \x20-\x2f, final \x40-\x7e.
    [GeneratedRegex(@"\x1b\[[0-?]*[ -/]*[@-~]")]
    private static partial Regex Csi();

    // Any remaining two-byte escape (charset selects ESC(B, ESC=, single-shifts, etc.).
    [GeneratedRegex(@"\x1b[@-Z\\-_]|\x1b[()#][0-9A-Za-z]|\x1b.")]
    private static partial Regex OtherEscape();

    // Leftover C0 control bytes except tab/newline; carriage returns collapse to newline so a
    // redrawn line doesn't glue onto the previous one when we scan. \x1e survives: that is the
    // record separator this class writes for a cursor-move line break (see CursorBreak).
    [GeneratedRegex(@"[\x00-\x08\x0b\x0c\x0e-\x1d\x1f\x7f]")]
    private static partial Regex Controls();

    /// <summary>
    /// The line break a cursor move stands in for, kept distinct from a real CR/LF. Both start a line
    /// on screen, but only one of them means "the program just printed this": a scanner can tell a
    /// freshly streamed command result from the same block being repainted by which one introduced it.
    /// </summary>
    public const char CursorBreak = '\u001e';

    // A cursor-forward run stands in for spaces the TUI never actually emitted; one screen line is
    // as far as that can honestly go, and the cap also bounds a garbled parameter.
    private const int MaxCursorForwardSpaces = 240;

    /// <summary>Strip escape sequences and stray control bytes, leaving visible text (tabs/newlines kept).</summary>
    public static string Strip(string s) => Strip(s, cursorMovesEndLines: false);

    /// <summary>
    /// As <see cref="Strip(string)"/>, but with <paramref name="cursorMovesEndLines"/> a cursor
    /// reposition also breaks the line — as <see cref="CursorBreak"/>, not "\n", so the caller can
    /// still tell which kind it was. Claude's TUI starts a fresh screen row that way as often as it
    /// emits CRLF — a repaint jumps to the row it is about to draw — so a scanner that anchors on
    /// line starts (the /rename and /color sniffers) has to see those rows as separate lines. The
    /// watchdog deliberately does NOT: it counts lines to size its window, and a repaint's per-row
    /// cursor moves would shrink that window to a few characters of the screen.
    /// </summary>
    public static string Strip(string s, bool cursorMovesEndLines)
    {
        if (string.IsNullOrEmpty(s)) return s;
        s = Osc().Replace(s, "");
        s = Csi().Replace(s, m => CsiText(m.Value, cursorMovesEndLines));
        s = OtherEscape().Replace(s, "");
        s = s.Replace('\r', '\n');
        s = Controls().Replace(s, "");
        return s;
    }

    /// <summary>
    /// What a CSI sequence leaves behind on screen. Nearly all of them paint nothing — but a gap
    /// between two words is routinely drawn by moving the cursor over it rather than by writing
    /// spaces (Claude prints "Session color set to: red" as five words joined by <c>ESC[1C</c>), and
    /// dropping those turns the visible line into "Sessioncolorsetto:red". So cursor-forward comes
    /// back as the spaces it stood for, and — when asked — a reposition as the line break it is.
    /// </summary>
    private static string CsiText(string seq, bool cursorMovesEndLines)
    {
        var final = seq[^1];
        var body = seq[2..^1];
        // Private forms (ESC[?25l, ESC[>4m …) are modes and queries; they never paint.
        if (body.Length > 0 && body[0] is '?' or '<' or '=' or '>') return "";

        switch (final)
        {
            // CUF / HPR: the cursor skips over columns it leaves blank.
            case 'C' or 'a':
                return new string(' ', Math.Clamp(FirstParam(body), 1, MaxCursorForwardSpaces));

            // Every reposition: CUU/CUD, CNL/CPL, CHA/HPA, VPA, CUP/HVP. Wherever the cursor lands,
            // what it draws there belongs to a different screen row than what came before it — even a
            // jump within one row, since the TUI only makes those to skip over a gap it isn't drawing.
            // It breaks the line as CursorBreak rather than "\n" so a scanner can still tell the two
            // apart: a jump means the screen is being repainted, a CR/LF means output just arrived.
            case 'A' or 'B' or 'E' or 'F' or 'G' or '`' or 'd' or 'H' or 'f' when cursorMovesEndLines:
                return CursorBreak.ToString();

            default:
                return "";
        }
    }

    /// <summary>The first numeric parameter of a CSI body; 1 (the VT default) when it has none.</summary>
    private static int FirstParam(string body)
    {
        var end = body.IndexOf(';');
        // Trailing intermediates (\x20-\x2f) ride along with the parameter; drop them.
        var span = (end < 0 ? body.AsSpan() : body.AsSpan(0, end)).TrimEnd(" !\"#$%&'()*+,-./");
        return int.TryParse(span, out var v) ? v : 1;
    }
}
