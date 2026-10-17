using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace ClaudeWeb.PtyHost;

/// <summary>
/// The few libc calls the host needs on Linux and macOS, where there is no job object to lean on.
/// </summary>
[UnsupportedOSPlatform("windows")]
internal static class Unix
{
    // The same numbers on Linux and macOS.
    public const int SIGHUP = 1;
    private const int SIGINT = 2;
    private const int SIGQUIT = 3;
    public const int SIGKILL = 9;
    private const int SIGPIPE = 13;

    private static readonly IntPtr SIG_DFL = IntPtr.Zero;

    private const string Libc = "libc";

    static Unix()
    {
        // "libc" is not a file on either system: glibc's is libc.so.6 (libc.so is a linker script, and
        // only there with the dev package), and macOS keeps libc inside libSystem.
        NativeLibrary.SetDllImportResolver(typeof(Unix).Assembly, (name, assembly, path) =>
        {
            if (name != Libc) return IntPtr.Zero;
            foreach (var candidate in OperatingSystem.IsMacOS()
                         ? new[] { "/usr/lib/libSystem.B.dylib", "libSystem.dylib" }
                         : new[] { "libc.so.6", "libc.so" })
                if (NativeLibrary.TryLoad(candidate, assembly, path, out var handle)) return handle;
            return IntPtr.Zero;
        });
    }

    /// <summary>
    /// Leave the web app's session and process group for one of our own. This is what Windows gets from
    /// <c>DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP</c>: a Ctrl+C in the terminal the web app was
    /// started from, that terminal closing, or launchd sweeping the job's process group must not reach
    /// the session. Fails only when we already lead a group, which a freshly spawned process never does.
    /// </summary>
    public static bool Detach() => setsid() != -1;

    /// <summary>Signal a whole process group (a pty child leads its own, so its pid is the group's id).</summary>
    public static void SignalGroup(int pgid, int signal)
    {
        if (pgid > 1) _ = kill(-pgid, signal);
    }

    /// <summary>
    /// Run <paramref name="spawn"/> with the terminal's signals at their defaults. An ignored signal
    /// survives exec, and Porta.Pty's forkpty/execvp resets nothing (Process.Start does), so the child
    /// would otherwise start with whatever this process ignores:
    /// <list type="bullet">
    /// <item>SIGPIPE, which the .NET runtime always ignores — <c>yes | head -1</c> then prints "Broken
    /// pipe" instead of ending quietly, and a tool that ignores write errors never stops;</item>
    /// <item>SIGHUP, SIGINT and SIGQUIT, when the web app was started with <c>nohup</c> or as a
    /// background job of a script — Ctrl+C at a shell tab would then interrupt nothing.</item>
    /// </list>
    /// Safe to lift for the moment of the spawn: the host spawns once, before it opens any socket, and
    /// having left the web app's session (<see cref="Detach"/>) it has no terminal to be signalled by.
    /// </summary>
    /// <remarks>
    /// Saved and restored through <c>sigaction</c>, not <c>signal</c>: the runtime's own SIGINT and
    /// SIGQUIT handlers are installed with <c>SA_SIGINFO</c>, which putting a handler back with
    /// <c>signal</c> would drop. The saved action is kept as opaque bytes — <c>struct sigaction</c> is
    /// laid out differently on Linux and macOS, and nothing here needs to read it.
    /// </remarks>
    public static T WithDefaultSignals<T>(Func<T> spawn)
    {
        const int ActionBytes = 512; // comfortably more than struct sigaction on either system
        int[] signals = [SIGHUP, SIGINT, SIGQUIT, SIGPIPE];
        var saved = new IntPtr[signals.Length];
        try
        {
            for (var i = 0; i < signals.Length; i++)
            {
                var buffer = Marshal.AllocHGlobal(ActionBytes);
                saved[i] = buffer;
                if (sigaction(signals[i], IntPtr.Zero, buffer) != 0)
                {
                    Marshal.FreeHGlobal(buffer);
                    saved[i] = IntPtr.Zero; // couldn't read it, so it is left exactly as it is
                    continue;
                }
                signal(signals[i], SIG_DFL);
            }
            return spawn();
        }
        finally
        {
            for (var i = 0; i < signals.Length; i++)
            {
                if (saved[i] == IntPtr.Zero) continue;
                sigaction(signals[i], saved[i], IntPtr.Zero);
                Marshal.FreeHGlobal(saved[i]);
            }
        }
    }

    [DllImport(Libc, SetLastError = true)]
    private static extern IntPtr signal(int sig, IntPtr handler);

    [DllImport(Libc, SetLastError = true)]
    private static extern int sigaction(int sig, IntPtr act, IntPtr oldact);

    [DllImport(Libc, SetLastError = true)]
    private static extern int setsid();

    [DllImport(Libc, SetLastError = true)]
    private static extern int kill(int pid, int sig);
}
