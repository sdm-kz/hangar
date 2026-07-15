using System.Text;
using System.Text.RegularExpressions;

namespace ClaudeWeb.Server.Sessions;

/// <summary>Tunables for the hang watchdog (bound from the "Watchdog" config section).</summary>
public sealed class WatchdogOptions
{
    /// <summary>Master switch; when false the watchdog never writes to any session.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>How often to sweep all live sessions.</summary>
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

/// <summary>
/// Sweeps all live sessions and auto-recovers ones stuck on an API/streaming error banner by writing
/// "continue" to their PTY. Guardrails: never acts while Claude is emitting (covers its own retry),
/// never acts while a permission prompt is on screen, rate-limits per session, and gives up after
/// <see cref="WatchdogOptions.MaxConsecutive"/> tries (flagging the session for attention instead).
/// </summary>
public sealed class WatchdogService : BackgroundService
{
    private readonly SessionManager _mgr;
    private readonly WatchdogOptions _options;
    private readonly ILogger<WatchdogService> _log;
    private readonly Regex[] _errorPatterns;
    private readonly Regex[] _promptGuards;
    private readonly byte[] _sendBytes;

    public WatchdogService(SessionManager mgr, WatchdogOptions options, ILogger<WatchdogService> log)
    {
        _mgr = mgr;
        _options = options;
        _log = log;
        _errorPatterns = Compile(options.ErrorPatterns);
        _promptGuards = Compile(options.PromptGuardPatterns);
        _sendBytes = Encoding.UTF8.GetBytes(options.SendSequence);
    }

    /// <summary>Return the last <paramref name="maxLines"/> lines of <paramref name="text"/> (whole string if fewer).</summary>
    private static string Tail(string text, int maxLines)
    {
        int newlines = 0;
        for (int i = text.Length - 1; i >= 0; i--)
            if (text[i] == '\n' && ++newlines == maxLines)
                return text[(i + 1)..];
        return text;
    }

    private Regex[] Compile(IEnumerable<string> patterns)
    {
        var list = new List<Regex>();
        foreach (var p in patterns)
        {
            try { list.Add(new Regex(p, RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant)); }
            catch (Exception ex) { _log.LogWarning(ex, "Ignoring invalid watchdog pattern: {Pattern}", p); }
        }
        return list.ToArray();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled)
        {
            _log.LogInformation("Watchdog disabled by configuration.");
            return;
        }
        _log.LogInformation("Watchdog started (poll {Poll}ms, cooldown {Cooldown}ms, max {Max}).",
            _options.PollIntervalMs, _options.CooldownMs, _options.MaxConsecutive);

        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(Math.Max(250, _options.PollIntervalMs)));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            // Wrap the whole sweep: a failure here must never end ExecuteAsync (which, even with the
            // host's StopHost behaviour disabled, would silently stop the watchdog for the app's life).
            try
            {
                foreach (var s in _mgr.LiveSessions())
                {
                    try { await CheckAsync(s, stoppingToken); }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception ex) { _log.LogDebug(ex, "Watchdog check failed for session {Id}", s.Id); }
                }
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) { _log.LogWarning(ex, "Watchdog sweep failed; continuing on next tick."); }
        }
    }

    private async Task CheckAsync(ClaudeSession s, CancellationToken ct)
    {
        // Disabled for this session: force a clean state and leave it alone.
        if (!s.WatchdogEnabled)
        {
            s.WatchdogStatus = "healthy";
            s.WatchdogConsecutive = 0;
            return;
        }

        var term = s.Terminal;
        if (s.State != SessionState.Running || term is null) return;

        // Claude is emitting — working normally or auto-retrying. Don't judge or act until it settles.
        if (term.IsBusy) return;

        // Scan roughly the current screen, not the whole 32 KB tail, so a banner from an earlier turn
        // that's still sitting in scrollback can't trigger a spurious continue once Claude has moved
        // on. Kept generous (≥ two screenfuls) so a banner actually on screen is never missed.
        var text = Tail(term.RecentText, Math.Max(50, term.Rows * 2));

        // Guardrail: a permission/confirmation prompt is on screen — never auto-send input.
        if (_promptGuards.Any(r => r.IsMatch(text))) return;

        bool hung = _errorPatterns.Any(r => r.IsMatch(text));
        if (!hung)
        {
            // Idle at a healthy prompt: recovered (or never broke). Clear state.
            s.WatchdogConsecutive = 0;
            s.WatchdogStatus = "healthy";
            return;
        }

        var now = Environment.TickCount64;
        if (s.WatchdogLastContinueTick != 0 && now - s.WatchdogLastContinueTick < _options.CooldownMs)
            return; // still cooling down since the last attempt

        if (s.WatchdogConsecutive >= _options.MaxConsecutive)
        {
            if (s.WatchdogStatus != "attention")
            {
                s.WatchdogStatus = "attention";
                _log.LogWarning("Watchdog gave up on session {Id} ({Name}) after {N} auto-continue(s).",
                    s.Id, s.Name, s.WatchdogConsecutive);
            }
            return;
        }

        await term.WriteAsync(_sendBytes, ct);
        s.WatchdogConsecutive++;
        s.WatchdogLastContinueTick = now;
        s.WatchdogStatus = "recovering";
        _log.LogInformation("Watchdog auto-continued session {Id} ({Name}), attempt {N}/{Max}.",
            s.Id, s.Name, s.WatchdogConsecutive, _options.MaxConsecutive);
    }
}
