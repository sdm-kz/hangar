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
    // redrawn line doesn't glue onto the previous one when we scan.
    [GeneratedRegex(@"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")]
    private static partial Regex Controls();

    /// <summary>Strip escape sequences and stray control bytes, leaving visible text (tabs/newlines kept).</summary>
    public static string Strip(string s)
    {
        if (string.IsNullOrEmpty(s)) return s;
        s = Osc().Replace(s, "");
        s = Csi().Replace(s, "");
        s = OtherEscape().Replace(s, "");
        s = s.Replace('\r', '\n');
        s = Controls().Replace(s, "");
        return s;
    }
}
