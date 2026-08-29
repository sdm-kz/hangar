namespace ClaudeWeb.Pty;

/// <summary>
/// Tunables for the hang watchdog (bound from the "Watchdog" config section in the web app, then
/// handed to each pty host in its spawn request).
/// </summary>
/// <remarks>
/// Shared because the watchdog itself runs in the pty host: it needs the terminal's recent text and
/// write access, and — the point of putting it there — a session that stalls at 3 a.m. during an
/// update window should still be recovered while the web app is down. A host keeps the options it
/// was spawned with, so a config change reaches existing sessions only when they are relaunched.
/// </remarks>
public sealed class WatchdogOptions
{
    /// <summary>Master switch; when false no host ever auto-continues its session.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>How often the host re-examines its session.</summary>
    public int PollIntervalMs { get; set; } = 2000;

    /// <summary>Minimum gap between auto-continues for a single session.</summary>
    public int CooldownMs { get; set; } = 20000;

    /// <summary>Auto-continues to attempt before giving up and flagging the session for attention.</summary>
    public int MaxConsecutive { get; set; } = 3;

    /// <summary>Bytes written to recover — the docs' remedy for a mid-response drop is to reply "continue".</summary>
    public string SendSequence { get; set; } = "continue\r";

    /// <summary>Case-insensitive regexes; any match in recent on-screen text ⇒ the session looks hung.</summary>
    public string[] ErrorPatterns { get; set; } =
    {
        @"API Error:\s*\d{3}",
        @"API Error:",
        @"Unable to connect to API",
        @"fetch failed",
        @"Request timed out",
        @"The response above may be incomplete",
        @"mid-stream",   // "Response stalled mid-stream…" — the classic streaming error
        @"mid-response", // "Connection/Server … mid-response…"
        @"Overloaded",   // "Repeated 529 Overloaded errors…"
        @"\(429\)",      // "Request rejected (429) · this may be a temporary capacity issue…"
        @"\(529\)",      // overload banner variant
    };

    /// <summary>
    /// Case-insensitive regexes for a permission/confirmation prompt on screen. If ANY matches, the
    /// watchdog never sends input (so it can't auto-answer a dialog). Best-effort — the exact prompt
    /// wording isn't documented, so tighten these against a live session.
    /// </summary>
    public string[] PromptGuardPatterns { get; set; } =
    {
        // NOTE: do NOT guard on a bare "❯" — Claude Code's normal input box also renders it, which
        // would make the watchdog think a prompt is always waiting and never auto-continue. Match the
        // permission dialog's actual wording / numbered options instead.
        @"Do you want",
        @"❯\s*\d+\.", // the ❯ cursor on a numbered option (works only where the glyph survives)
        // A numbered selection menu: a line starting with the selector — ASCII '>' or the ❯ glyph,
        // which the Latin1-decoded RecentText mangles into non-ASCII bytes — followed by "N." / "N)".
        // Requires a digit after the selector, so it matches a menu but not the normal input box; and
        // requires the selector, so it doesn't match Claude's plain numbered lists (which start "N.").
        @"(?m)^\s{0,4}(?:>|[^\x00-\x7f]{1,4})\s*\d+[.)]\s",
        @"\b1\.\s*Yes\b",
        @"\(y/n\)",
        @"\[y/N\]",
        @"don't ask again",
    };
}
