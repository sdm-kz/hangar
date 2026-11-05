using Hangar.PtyHost.Pty;

namespace Hangar.PtyHost;

/// <summary>
/// Hands the memory a burst of output left behind back to the OS once the terminal goes quiet.
/// </summary>
/// <remarks>
/// <para>What a host keeps is small: the screen, and a few thousand scrolled-off lines as text. Running
/// output through the screen model allocates far more than that on the way, though, and so does drawing
/// the snapshot an attaching viewer is sent, and the GC holds on to what it grew into: a 3000-line burst
/// left a host at ~25 MB of private memory, of which an aggressive collection returned all but ~6. An
/// ordinary full collection returns none of it. One of these hosts runs per session and per shell tab,
/// for days, so the difference is multiplied by everything open.</para>
/// <para>Quiet is read off the terminal (<see cref="TerminalChannel.BytesProcessed"/>) rather than the
/// allocation counter: the watchdog works out and pushes the session's state every second, so the host
/// never stops allocating, but it does stop printing. A collection follows only real work since the last one, so an idle
/// session isn't collected over and over; and only after two ticks without any, so a TUI that is still
/// drawing isn't paused mid-frame. A host's heap is a few megabytes, which an aggressive collection gets
/// through in milliseconds.</para>
/// </remarks>
internal sealed class HeapTrimmer(TerminalChannel terminal)
{
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Work since the last collection that makes another worth it. Low on purpose: the burst above was
    /// ~40 KB of output for ~20 MB of heap.
    /// </summary>
    private const long MinBytes = 64 * 1024;

    /// <summary>Run until <paramref name="ct"/> is cancelled.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        long trimmedAt = 0, seen = 0;
        var quietTicks = 0;
        using var timer = new PeriodicTimer(Tick);
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                var processed = terminal.BytesProcessed;
                quietTicks = processed == seen ? quietTicks + 1 : 0;
                seen = processed;
                if (quietTicks < 2 || processed - trimmedAt < MinBytes) continue;
                GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
                trimmedAt = processed;
            }
        }
        catch (OperationCanceledException) { }
    }
}
