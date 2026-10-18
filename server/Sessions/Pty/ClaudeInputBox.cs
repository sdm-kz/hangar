using ClaudeWeb.Pty;

namespace ClaudeWeb.Server.Sessions.Pty;

/// <summary>
/// Claude Code's input box, read off the screen: whether something has been typed into it and not
/// sent. The sidebar marks a session with a draft, so a half-written prompt left in one session is
/// not forgotten while you work in another.
/// </summary>
/// <remarks>
/// <para>The box is the rows between the last two horizontal rules on the screen, the first of
/// them starting with the prompt character:</para>
/// <code>
/// ────────────────────────────
/// ❯ let's plan new feature
///   it should allow to run
/// ────────────────────────────
///   ⏵⏵ auto mode on
/// </code>
/// <para>Read with the pens, not as text, because an empty box is not empty: it shows a placeholder
/// (<c>Try "refactor &lt;filepath&gt;"</c>) that plain text cannot tell from the same words typed in.
/// Claude draws that placeholder dim and what you type in the plain pen, so a draft is any visible
/// character in the box that isn't dim. Inverse cells are skipped too: a TUI that paints its own
/// cursor does so in inverse, sometimes on the first letter of the placeholder.</para>
/// <para>Best-effort, like every screen reading. While a dialog has replaced the box (a permission
/// prompt) there is no box to read, and a draft behind it reads as none until the box comes back.</para>
/// </remarks>
internal static class ClaudeInputBox
{
    private const int Rule = '─';

    // The prompt character: ❯ now, > in older versions, ! in bash mode.
    private static bool IsPrompt(int rune) => rune is '❯' or '>' or '!';

    public static bool HasDraft(ScreenModel screen)
    {
        // The bottom rule first, then the one above it: the box sits at the foot of the screen, under
        // anything in the transcript that happens to draw a rule of its own.
        int bottom = -1, top = -1;
        for (var y = screen.Rows - 1; y >= 0; y--)
        {
            if (!IsRule(screen, y)) continue;
            if (bottom < 0) bottom = y;
            else { top = y; break; }
        }
        if (top < 0 || bottom - top < 2) return false;
        if (!IsPrompt(screen.CellAt(0, top + 1).Rune)) return false;

        // Past the two columns every line of the box starts with: the prompt and its gap on the first,
        // the indent that lines the rest up under it.
        for (var y = top + 1; y < bottom; y++)
            for (var x = 2; x < screen.Cols; x++)
            {
                var cell = screen.CellAt(x, y);
                if (cell.IsBlank || cell.IsWideTail) continue;
                if ((cell.Pen.Flags & (Pen.Dim | Pen.Inverse | Pen.Invisible)) != 0) continue;
                return true;
            }
        return false;
    }

    // A rule starts at the left edge and runs most of the way across. "Most", not "all": Claude can
    // set a label into its border, and a narrow screen leaves less of it to be rule.
    private static bool IsRule(ScreenModel screen, int y)
    {
        if (screen.CellAt(0, y).Rune != Rule) return false;
        var count = 0;
        for (var x = 0; x < screen.Cols; x++)
            if (screen.CellAt(x, y).Rune == Rule) count++;
        return count * 2 >= screen.Cols;
    }
}
