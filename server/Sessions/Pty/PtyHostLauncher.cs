using System.Runtime.InteropServices;
using System.Text;
using ClaudeWeb.Pty;

namespace ClaudeWeb.Server.Sessions.Pty;

/// <summary>Tunables for the pty host (bound from the "Pty" config section).</summary>
public sealed class PtyHostOptions
{
    /// <summary>
    /// Namespaces this instance's pipe names and pty state directory. <b>Load-bearing:</b>
    /// <c>%LocalAppData%\ClaudeWeb</c> is shared by every instance on the machine, so without it a dev
    /// instance on another port would adopt the live app's hosts — and could then stop them. Left
    /// empty in config; the host fills it in from the bound port (see <c>Program.cs</c>).
    /// </summary>
    public string InstanceKey { get; set; } = "";

    /// <summary>
    /// Path to <c>ClaudeWeb.PtyHost.exe</c>. Empty means "next to this app's own executable", which is
    /// where both <c>build.ps1</c> and the updater put it.
    /// </summary>
    public string HostExecutable { get; set; } = "";

    /// <summary>How long to wait for a host to answer its pipe before calling its state file stale.</summary>
    public int AttachTimeoutMs { get; set; } = 3000;

    /// <summary>How long to wait for a freshly spawned host to come up and accept the first client.</summary>
    public int StartTimeoutMs { get; set; } = 20000;

    /// <summary>
    /// Stop orphaned hosts — ones still running for a session this app no longer knows about — once
    /// they are older than this many hours. <c>0</c> (the default) never does, which is the safe
    /// reading: an orphan is still a live <c>claude</c> that someone may want back, and the UI offers
    /// stopping them explicitly. Set it if unattended cleanup matters more than the odd lost session.
    /// </summary>
    public double OrphanMaxAgeHours { get; set; }
}

/// <summary>
/// Starts a pty host process for a session and hands back a connected <see cref="PtyHostClient"/>.
/// </summary>
/// <remarks>
/// <para>The spawn flags are the load-bearing part. <c>DETACHED_PROCESS</c> so the host gets no
/// console of ours; <c>CREATE_NEW_PROCESS_GROUP</c> so a Ctrl+C in our group can't reach it; no
/// handle inheritance; and <c>CREATE_BREAKAWAY_FROM_JOB</c> <b>where the parent job allows it</b> —
/// if <c>ClaudeWeb.exe</c> is ever inside a job with kill-on-close (a service host, a debugger, some
/// CI parents), the host would otherwise inherit that job and die with us, silently defeating the
/// entire feature. Windows refuses the flag when the job forbids breakaway, so we try it and retry
/// without on ERROR_ACCESS_DENIED.</para>
/// <para>The host binary is launched from a per-build copy under <c>%LocalAppData%</c>, never from
/// the install folder: <c>apply-update.ps1</c> mirrors over the install folder, and a running host
/// would be a locked file sitting in its path.</para>
/// </remarks>
public sealed class PtyHostLauncher(PtyHostOptions options, ILogger log)
{
    /// <summary>Where per-build copies of the host binary live.</summary>
    private static string CopyRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeWeb", "ptyhost");

    private readonly object _copyLock = new();
    private string? _launchPath;   // the per-build copy we launch from, resolved once
    private string? _buildStamp;

    /// <summary>The instance key in force, defaulted so a misconfigured instance still isolates itself.</summary>
    public string InstanceKey => string.IsNullOrWhiteSpace(options.InstanceKey) ? "default" : options.InstanceKey;

    /// <summary>
    /// Launch a host for <paramref name="sessionId"/> and attach to it. Throws when the host binary is
    /// missing, can't be started, or never answers its pipe.
    /// </summary>
    public async Task<PtyHostClient> StartAsync(
        string sessionId, string fileName, IReadOnlyList<string> arguments, string workingDirectory,
        IReadOnlyDictionary<string, string> environment, short cols, short rows,
        WatchdogOptions watchdog, bool watchdogEnabled, bool verbatimArguments = false,
        CancellationToken ct = default)
    {
        var exe = ResolveLaunchPath();
        var pipeName = PtyStateStore.PipeName(InstanceKey, sessionId);
        var stateFile = PtyStateStore.PathFor(InstanceKey, sessionId);
        var logFile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "logs", $"ptyhost-{sessionId}.log");

        // The request carries the hook token and the user's initial prompt, so it goes in a file the
        // host deletes on read rather than on a command line any process on the box can enumerate.
        var requestFile = Path.Combine(Path.GetDirectoryName(stateFile)!, $"{sessionId}.spawn.json");
        PtySpawnRequestStore.Write(requestFile, new PtySpawnRequest(
            SessionId: sessionId,
            PipeName: pipeName,
            StateFile: stateFile,
            LogFile: logFile,
            FileName: fileName,
            Arguments: arguments,
            WorkingDirectory: workingDirectory,
            Cols: cols,
            Rows: rows,
            Environment: environment,
            BuildStamp: _buildStamp,
            // The watchdog runs host-side, so its tunables travel with the spawn. A host keeps the
            // ones it started with: a config change reaches an existing session only when it relaunches.
            Watchdog: watchdog,
            WatchdogEnabled: watchdogEnabled,
            VerbatimArguments: verbatimArguments));

        int hostPid;
        try
        {
            hostPid = SpawnDetached(exe, $"\"{exe}\" --spawn \"{requestFile}\"", workingDirectory);
        }
        catch
        {
            try { File.Delete(requestFile); } catch { }
            throw;
        }
        log.LogInformation("Started pty host pid {Pid} for session {Id} (pipe '{Pipe}').", hostPid, sessionId, pipeName);

        // The host has to launch the child and open its pipe before we can attach; poll rather than
        // guess a delay, and give up with a clear error rather than leaving a half-started session.
        var client = await ConnectWithRetryAsync(pipeName, sessionId, options.StartTimeoutMs, ct);
        if (client is null)
        {
            try { File.Delete(requestFile); } catch { }
            // The host may still be up with a child under it, and the session it belongs to is about
            // to be discarded — so take it down now rather than leave behind an orphan nobody asked
            // for. (A host that never answered its pipe can't be stopped politely.)
            KillHost(sessionId);
            throw new InvalidOperationException(
                $"The pty host (pid {hostPid}) never accepted a connection on '{pipeName}'. See {logFile}.");
        }
        return client;
    }

    /// <summary>Attach to a host that is already running (adoption at startup); null when nothing answers.</summary>
    public Task<PtyHostClient?> AttachAsync(string sessionId, string pipeName, CancellationToken ct = default) =>
        PtyHostClient.ConnectAsync(pipeName, sessionId, options.AttachTimeoutMs, log, ct);

    private async Task<PtyHostClient?> ConnectWithRetryAsync(string pipeName, string sessionId, int timeoutMs, CancellationToken ct)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            var client = await PtyHostClient.ConnectAsync(pipeName, sessionId, 500, log, ct);
            if (client is not null) return client;
            await Task.Delay(100, ct);
        }
        return null;
    }

    /// <summary>
    /// The host binary to launch: a copy under <c>%LocalAppData%\ClaudeWeb\ptyhost\&lt;buildStamp&gt;</c>,
    /// made once per build. Copying is what keeps the updater working — mirroring over the install
    /// folder must never meet a running, locked host exe. Falls back to the installed binary if the
    /// copy fails, since a working session beats a tidy update path.
    /// </summary>
    private string ResolveLaunchPath()
    {
        lock (_copyLock)
        {
            if (_launchPath is not null && File.Exists(_launchPath)) return _launchPath;

            var installed = InstalledHostPath();
            if (!File.Exists(installed))
                throw new FileNotFoundException(
                    $"ClaudeWeb.PtyHost.exe was not found at '{installed}'. It is published alongside ClaudeWeb.exe by scripts\\build.ps1.", installed);

            _buildStamp = BuildStamp(installed);
            if (!IsSingleFile(installed))
            {
                // A local build: launching a lone copy of the exe would leave it without its runtime.
                log.LogDebug("Pty host at {Path} is not a single-file build; launching it in place.", installed);
                return _launchPath = installed;
            }
            var target = Path.Combine(CopyRoot, _buildStamp, "ClaudeWeb.PtyHost.exe");
            try
            {
                if (!File.Exists(target) || new FileInfo(target).Length != new FileInfo(installed).Length)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    File.Copy(installed, target, overwrite: true);
                    log.LogInformation("Copied the pty host binary to {Path} (build {Stamp}).", target, _buildStamp);
                }
                PruneUnusedCopies(_buildStamp);
                _launchPath = target;
            }
            catch (Exception ex)
            {
                // A locked or in-use copy is the expected failure here (another instance launching at
                // the same moment); using it directly is fine if it exists, otherwise fall back.
                if (File.Exists(target)) _launchPath = target;
                else
                {
                    log.LogWarning(ex, "Could not stage the pty host binary; launching from the install folder instead.");
                    _launchPath = installed;
                }
            }
            return _launchPath;
        }
    }

    /// <summary>
    /// Where the host binary sits. Beside the app in a published install; in a <c>ptyhost</c>
    /// subfolder for a local <c>dotnet run</c>, which the server project's CopyPtyHostForLocalRun
    /// target fills. <c>Pty:HostExecutable</c> overrides both.
    /// </summary>
    private string InstalledHostPath()
    {
        if (!string.IsNullOrWhiteSpace(options.HostExecutable))
            return Path.GetFullPath(options.HostExecutable);
        var published = Path.Combine(AppContext.BaseDirectory, "ClaudeWeb.PtyHost.exe");
        if (File.Exists(published)) return published;
        var local = Path.Combine(AppContext.BaseDirectory, "ptyhost", "ClaudeWeb.PtyHost.exe");
        return File.Exists(local) ? local : published; // report the published path when neither exists
    }

    /// <summary>
    /// Whether the host binary is a self-contained single file, and so safe to copy on its own. A
    /// local build isn't — it needs its sibling assemblies — so it is launched where it stands, and
    /// only the published binary gets the per-build staging the updater relies on.
    /// </summary>
    private static bool IsSingleFile(string exe) =>
        !File.Exists(Path.ChangeExtension(exe, ".dll"));

    /// <summary>
    /// Names the build a host copy came from. The exe's own last-write time and size identify it well
    /// enough for a cache key, and unlike build.json it's still right for a locally-run dev build.
    /// </summary>
    private static string BuildStamp(string exe)
    {
        var info = new FileInfo(exe);
        return $"{info.LastWriteTimeUtc:yyyyMMddHHmmss}-{info.Length}";
    }

    /// <summary>
    /// Drop per-build copies of the host binary that nothing is running from any more.
    /// </summary>
    /// <remarks>
    /// The set to keep is taken from the state files of <b>every instance on the machine</b>, not just
    /// ours: <c>%LocalAppData%\ClaudeWeb\ptyhost</c> is shared, and deleting a build a dev instance
    /// (or a service alongside the tray app) still has live hosts on would be destructive. Windows
    /// would refuse to delete a running exe anyway, but relying on a file lock to enforce that is a
    /// thin guarantee to hang sessions on. Best-effort throughout — a folder that won't delete is
    /// simply retried on the next launch.
    /// </remarks>
    private void PruneUnusedCopies(string keep)
    {
        try
        {
            var inUse = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { keep };
            foreach (var (_, state) in PtyStateStore.ReadAllInstances())
                if (state.BuildStamp is { Length: > 0 } stamp && PtyStateStore.HostAlive(state))
                    inUse.Add(stamp);

            foreach (var dir in Directory.EnumerateDirectories(CopyRoot))
            {
                var stamp = Path.GetFileName(dir);
                if (inUse.Contains(stamp)) continue;
                try
                {
                    Directory.Delete(dir, recursive: true);
                    log.LogInformation("Pruned the pty host copy for build {Stamp}; nothing is running from it.", stamp);
                }
                catch (Exception ex) { log.LogDebug(ex, "Could not prune the pty host copy {Dir}", dir); }
            }
        }
        catch (Exception ex) { log.LogDebug(ex, "Could not prune old pty host copies"); }
    }

    // ---- Host lifetime, shared by a session's Stop and by orphan cleanup -------------------------

    /// <summary>This session's pty state file, whether or not a host is behind it.</summary>
    public PtyState? StateFor(string sessionId) =>
        PtyStateStore.Read(PtyStateStore.PathFor(InstanceKey, sessionId));

    /// <summary>Wait for a session's host process to exit; false if it's still there when time runs out.</summary>
    public bool WaitForHostExit(string sessionId, TimeSpan timeout)
    {
        var state = StateFor(sessionId);
        if (state is null) return true; // the host already cleaned up after itself
        try
        {
            using var p = System.Diagnostics.Process.GetProcessById(state.HostPid);
            return p.WaitForExit((int)timeout.TotalMilliseconds);
        }
        catch { return true; } // already gone
    }

    /// <summary>
    /// Terminate a session's host and forget its state file. This is a complete teardown, not a
    /// partial one: the pseudoconsole's job object is kill-on-close and job membership is inherited,
    /// so <c>claude.exe</c> and anything we launched it through go down with the host. Used as the
    /// backstop for a host that ignored <c>shutdown</c>, and as the whole story for an orphan.
    /// </summary>
    public void KillHost(string sessionId)
    {
        var path = PtyStateStore.PathFor(InstanceKey, sessionId);
        var state = PtyStateStore.Read(path);
        if (state is null || !PtyStateStore.HostAlive(state)) { PtyStateStore.Delete(path); return; }
        try
        {
            using var p = System.Diagnostics.Process.GetProcessById(state.HostPid);
            log.LogWarning("Terminating pty host pid {Pid} for session {Id}.", state.HostPid, sessionId);
            p.Kill();
            p.WaitForExit(3000);
        }
        catch (Exception ex) { log.LogWarning(ex, "Error terminating the pty host for session {Id}", sessionId); }
        PtyStateStore.Delete(path);
    }

    /// <summary>
    /// Stop a host we are not attached to — an orphan. Asks it politely first, on the same
    /// <c>shutdown</c> message a live session uses, then insists.
    /// </summary>
    public async Task StopHostAsync(string sessionId, TimeSpan grace, CancellationToken ct = default)
    {
        var state = StateFor(sessionId);
        if (state is null) return;
        try
        {
            var client = await AttachAsync(sessionId, state.PipeName, ct);
            if (client is not null)
            {
                await client.ShutdownAsync(kill: true, ct);
                WaitForHostExit(sessionId, grace);
                client.Dispose();
            }
        }
        catch (Exception ex) { log.LogDebug(ex, "Orphaned pty host for session {Id} did not acknowledge shutdown", sessionId); }
        KillHost(sessionId);
    }

    // ---- CreateProcess, because .NET's Process.Start can't ask for these flags -------------------

    private const uint DETACHED_PROCESS = 0x00000008;
    private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    private const int ERROR_ACCESS_DENIED = 5;

    /// <summary>
    /// Start the host with no console, no inherited handles and its own process group, breaking away
    /// from our job where that's permitted. Returns the new pid.
    /// </summary>
    private int SpawnDetached(string exe, string commandLine, string workingDirectory)
    {
        const uint baseFlags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT;

        if (TryCreateProcess(exe, commandLine, workingDirectory, baseFlags | CREATE_BREAKAWAY_FROM_JOB, out var pid, out var error))
            return pid;

        // ERROR_ACCESS_DENIED here means the job we're in doesn't permit breakaway. That's fine as long
        // as the job isn't kill-on-close — and there's nothing we can do about it either way, so run
        // inside it rather than refusing to launch the session at all.
        if (error == ERROR_ACCESS_DENIED)
        {
            log.LogDebug("CREATE_BREAKAWAY_FROM_JOB was refused; starting the pty host inside our job object.");
            if (TryCreateProcess(exe, commandLine, workingDirectory, baseFlags, out pid, out error))
                return pid;
        }

        throw new System.ComponentModel.Win32Exception(error, $"Could not start the pty host '{exe}': {new System.ComponentModel.Win32Exception(error).Message}");
    }

    private static bool TryCreateProcess(string exe, string commandLine, string workingDirectory, uint flags, out int pid, out int error)
    {
        var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>() };
        var commandLineBuffer = new StringBuilder(commandLine);
        // The host inherits our environment; it only needs enough to find its own runtime, and the
        // CHILD's environment travels in the spawn request instead.
        bool ok = CreateProcessW(
            exe, commandLineBuffer, IntPtr.Zero, IntPtr.Zero, bInheritHandles: false,
            flags, IntPtr.Zero,
            Directory.Exists(workingDirectory) ? workingDirectory : AppContext.BaseDirectory,
            ref si, out var pi);
        error = ok ? 0 : Marshal.GetLastWin32Error();
        pid = ok ? (int)pi.dwProcessId : 0;
        if (ok)
        {
            // We keep neither handle: the host is on its own from here, and holding its process handle
            // would only keep a zombie entry alive in our table.
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
        }
        return ok;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string? lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
}
