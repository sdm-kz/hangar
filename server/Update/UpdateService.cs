using System.Diagnostics;
using System.Reflection;
using Microsoft.Extensions.Hosting.WindowsServices;

namespace Hangar.Server.Update;

// UpdateState lives in shared\Contract\Update.cs: the tray reads it off the event stream too.

/// <summary>What the UI needs to decide whether to offer an update, and what to say about it.</summary>
/// <param name="Enabled">Whether the updater is switched on at all (Update:Enabled).</param>
/// <param name="Available">A staged build exists and it isn't the one running.</param>
/// <param name="Current">The running build; null when the app wasn't built by scripts\build.ps1.</param>
/// <param name="Staged">The build waiting in the staging folder, if any.</param>
/// <param name="State">Whether an update is currently being applied.</param>
/// <param name="Error">Why the last apply attempt failed, when <see cref="State"/> is Failed.</param>
public sealed record UpdateStatus(
    bool Enabled,
    bool Available,
    BuildStamp? Current,
    BuildStamp? Staged,
    UpdateState State,
    string? Error);

/// <summary>
/// The in-app half of the updater. Watches the staging folder scripts\stage-update.ps1 publishes into
/// and, when it holds a build other than the running one, reports it as available so the UI can offer
/// a one-click update.
///
/// Applying is a hand-off, because a running single-file exe can't overwrite itself: this class
/// extracts scripts\apply-update.ps1 (embedded at build time) somewhere outside the install folder,
/// starts it detached with the pid to wait for, and then stops this app. The script does the rest —
/// mirror the payload over the install folder, restart the app the way it was running. The sessions
/// that were live come back on their own, the same as after any restart (Sessions:ResumeOnStart).
/// </summary>
public sealed class UpdateService : BackgroundService
{
    /// <summary>Grace period between telling the browsers "updating…" and actually going down.</summary>
    private static readonly TimeSpan ShutdownDelay = TimeSpan.FromSeconds(2);

    private readonly UpdateOptions _options;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly ILogger<UpdateService> _log;

    private readonly string _payloadPath;   // <StagingPath>\payload — the staged build itself
    private readonly string? _installPath;  // folder the running exe lives in (or the configured override)
    private readonly BuildStamp? _current;

    private FileSystemWatcher? _watcher;
    // Wakes the poll loop early when the watcher sees the staging folder change. Capacity 1 coalesces
    // the burst of events a robocopy produces into a single re-read.
    private readonly SemaphoreSlim _wake = new(0, 1);

    private readonly object _gate = new();
    private BuildStamp? _staged;
    private UpdateState _state = UpdateState.Idle;
    private string? _error;

    /// <summary>Raised when the staged build or the apply state changes, so the hub can push it.</summary>
    public event Action? Changed;

    public UpdateService(UpdateOptions options, IHostApplicationLifetime lifetime, ILogger<UpdateService> log)
    {
        _options = options;
        _lifetime = lifetime;
        _log = log;

        _payloadPath = Path.Combine(options.StagingPath, "payload");
        _installPath = string.IsNullOrWhiteSpace(options.InstallPath)
            ? (Environment.ProcessPath is { } exe ? Path.GetDirectoryName(exe) : null)
            : options.InstallPath;
        // The stamp is written next to the exe, which for a published build is also the content root.
        _current = BuildStamp.Read(_installPath) ?? BuildStamp.Read(AppContext.BaseDirectory);
    }

    public UpdateStatus Status
    {
        get
        {
            lock (_gate)
            {
                var available = _options.Enabled && _staged?.IsNewerThan(_current) == true;
                return new UpdateStatus(_options.Enabled, available, _current, _staged, _state, _error);
            }
        }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!_options.Enabled)
        {
            _log.LogInformation("Updater disabled (Update:Enabled=false).");
            return;
        }

        _log.LogInformation("Updater watching {Payload} (running build {BuildId}).",
            _payloadPath, _current?.BuildId ?? "unknown");
        StartWatching();

        var interval = TimeSpan.FromSeconds(Math.Max(5, _options.PollSeconds));
        while (!ct.IsCancellationRequested)
        {
            RereadStaged();
            try { await _wake.WaitAsync(interval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>
    /// Watch the staging folder so a freshly staged build shows up in the UI within a moment rather
    /// than on the next poll. Best-effort: the poll loop is the guarantee, this is only the speed.
    /// </summary>
    private void StartWatching()
    {
        try
        {
            Directory.CreateDirectory(_options.StagingPath);
            _watcher = new FileSystemWatcher(_options.StagingPath)
            {
                IncludeSubdirectories = true,
                // The interesting event is build.json appearing in the swapped-in payload folder;
                // the rename that swaps it in shows up here too.
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite,
                EnableRaisingEvents = true,
            };
            _watcher.Created += (_, _) => Wake();
            _watcher.Changed += (_, _) => Wake();
            _watcher.Renamed += (_, _) => Wake();
            _watcher.Deleted += (_, _) => Wake();
            // A watcher whose buffer overflows stops reporting; the poll loop carries on regardless.
            _watcher.Error += (_, e) => _log.LogDebug(e.GetException(), "Staging watcher error");
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not watch {Path}; falling back to polling only.", _options.StagingPath);
        }
    }

    private void Wake()
    {
        try { _wake.Release(); } catch (SemaphoreFullException) { /* a re-read is already pending */ }
    }

    private void RereadStaged()
    {
        var staged = BuildStamp.Read(_payloadPath);
        bool changed;
        lock (_gate)
        {
            changed = staged?.BuildId != _staged?.BuildId;
            _staged = staged;
        }
        if (!changed) return;

        if (staged is not null && staged.IsNewerThan(_current))
            _log.LogInformation("Update staged: {BuildId} (running {Current}).", staged.BuildId, _current?.BuildId ?? "unknown");
        else if (staged is not null && staged.BuildId != _current?.BuildId)
            _log.LogInformation("Staged build {BuildId} is older than the running {Current}; not offering it.",
                staged.BuildId, _current?.BuildId ?? "unknown");
        Changed?.Invoke();
    }

    /// <summary>
    /// Hand the staged build off to the external updater and begin shutting down. Returns the status
    /// the caller should report; on success it says Applying and this app has seconds left to live.
    /// </summary>
    public UpdateStatus Apply()
    {
        lock (_gate)
        {
            if (!_options.Enabled) return Fail("the updater is disabled (Update:Enabled=false)");
            if (_state == UpdateState.Applying) return Status; // already handed off — second click, same update
            if (_staged is null || _staged.BuildId == _current?.BuildId) return Fail("no update is staged");
            if (!_staged.IsNewerThan(_current)) return Fail("the staged build is older than the one running");
            if (string.IsNullOrWhiteSpace(_installPath)) return Fail("could not work out the install folder");
            if (!File.Exists(Path.Combine(_installPath, ServerExe)))
                return Fail($"'{_installPath}' is not a Hangar install (no {ServerExe}) — this looks like a dev run");
            if (!File.Exists(Path.Combine(_payloadPath, ServerExe)))
                return Fail($"the staged build has no {ServerExe}");
            if (SamePath(_installPath, _payloadPath))
                return Fail("the staging folder is the install folder — nothing to copy");

            try
            {
                var script = ExtractUpdater();
                var mode = ServiceMode();
                StartUpdater(script, mode);
                _state = UpdateState.Applying;
                _error = null;
                _log.LogInformation("Applying update {BuildId} ({Mode}); handing off to {Script}.",
                    _staged.BuildId, mode, script);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Could not start the updater.");
                return Fail(ex.Message);
            }
        }

        Changed?.Invoke();
        // Let the "updating…" snapshot reach the browsers, then go. From here the detached script owns
        // the update: it waits for this process to exit, replaces the files and starts the new build.
        _ = Task.Run(async () =>
        {
            await Task.Delay(ShutdownDelay);
            _log.LogInformation("Stopping for the update.");
            _lifetime.StopApplication();
        });
        return Status;
    }

    /// <summary>Record why the hand-off didn't happen and return the status saying so. Call under _gate.</summary>
    private UpdateStatus Fail(string reason)
    {
        _state = UpdateState.Failed;
        _error = reason;
        var status = new UpdateStatus(
            _options.Enabled,
            _staged?.IsNewerThan(_current) == true,
            _current, _staged, _state, _error);
        Task.Run(() => Changed?.Invoke());
        return status;
    }

    /// <summary>The server's executable in an install folder: an .exe on Windows, a bare name elsewhere.</summary>
    private static string ServerExe => OperatingSystem.IsWindows() ? "Hangar.exe" : "Hangar";

    // The unit this daemon runs as on Linux or macOS, if any (see CaptureServiceManager).
    private static string? _serviceManager;
    private static string? _serviceName;

    /// <summary>
    /// Read, then remove, the two variables scripts/install-unix.sh puts in the units it writes:
    /// <c>HANGAR_SERVICE_MANAGER</c> (systemd | launchd) and <c>HANGAR_SERVICE_NAME</c>. Called
    /// first thing in <c>Main</c>, before any session starts. Removing them is the point: every session
    /// and shell inherits this process's environment, so a second Hangar started from one of them — a
    /// test build, say — would otherwise believe it was the unit, and its updater would start, or on a
    /// timeout <i>stop</i>, the live app's unit.
    /// </summary>
    public static void CaptureServiceManager()
    {
        if (OperatingSystem.IsWindows()) return;
        // CLAUDEWEB_* is what a unit written before the rename sets.
        var manager = Environment.GetEnvironmentVariable("HANGAR_SERVICE_MANAGER")
                      ?? Environment.GetEnvironmentVariable("CLAUDEWEB_SERVICE_MANAGER");
        var name = Environment.GetEnvironmentVariable("HANGAR_SERVICE_NAME")
                   ?? Environment.GetEnvironmentVariable("CLAUDEWEB_SERVICE_NAME");
        foreach (var variable in new[] { "HANGAR_SERVICE_MANAGER", "HANGAR_SERVICE_NAME", "CLAUDEWEB_SERVICE_MANAGER", "CLAUDEWEB_SERVICE_NAME" })
            Environment.SetEnvironmentVariable(variable, null);
        if (manager is "systemd" or "launchd" && !string.IsNullOrWhiteSpace(name))
            (_serviceManager, _serviceName) = (manager, name);
    }

    /// <summary>
    /// How this process was started, so the updater can start the new build the same way: "service"
    /// under the Windows SCM; "systemd" or "launchd" when the unit said so (see
    /// <see cref="CaptureServiceManager"/>); otherwise "process", which relaunches the executable.
    /// </summary>
    private static string ServiceMode() =>
        OperatingSystem.IsWindows()
            ? WindowsServiceHelpers.IsWindowsService() ? "service" : "process"
            : _serviceManager ?? "process";

    /// <summary>
    /// Write the embedded updater script out where it can run. Deliberately NOT in the install
    /// folder — the script mirrors over that folder, so it would be replacing the file it's executing.
    /// </summary>
    private static string ExtractUpdater()
    {
        var dir = AppDataFolder.PathFor("update");
        Directory.CreateDirectory(dir);
        var name = OperatingSystem.IsWindows() ? "apply-update.ps1" : "apply-update.sh";
        var path = Path.Combine(dir, name);
        var resource = "Hangar.Server." + name;

        using var src = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource)
            ?? throw new InvalidOperationException($"'{resource}' is missing from the build");
        File.Delete(path); // so the mode below applies: it is only honoured when the file is created
        using var dst = OperatingSystem.IsWindows()
            ? File.Create(path)
            : new FileStream(path, new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
            });
        src.CopyTo(dst);
        return path;
    }

    private void StartUpdater(string script, string mode)
    {
        var waitSeconds = Math.Max(10, _options.ShutdownWaitSeconds).ToString();
        ProcessStartInfo psi;
        if (OperatingSystem.IsWindows())
        {
            psi = new ProcessStartInfo("powershell.exe");
            foreach (var arg in new[]
                     {
                         "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                         "-File", script,
                         "-Staging", _payloadPath,
                         "-Target", _installPath!,
                         "-ProcessId", Environment.ProcessId.ToString(),
                         "-Mode", mode,
                         "-WaitSeconds", waitSeconds,
                     })
                psi.ArgumentList.Add(arg);
        }
        else
        {
            // Through setsid where there is one (Linux), so the updater leaves our process group and a
            // signal aimed at us on the way down can't reach it. macOS has no setsid(1); there, the
            // launchd job's AbandonProcessGroup is what keeps it alive (see install-unix.sh).
            var setsid = new[] { "/usr/bin/setsid", "/bin/setsid" }.FirstOrDefault(File.Exists);
            psi = new ProcessStartInfo(setsid ?? "/bin/sh");
            if (setsid is not null) psi.ArgumentList.Add("/bin/sh");
            foreach (var arg in new[]
                     {
                         script, _payloadPath, _installPath!, Environment.ProcessId.ToString(), mode,
                         _serviceName ?? "", waitSeconds,
                     })
                psi.ArgumentList.Add(arg);
            // Its own output goes to update.log; ours may be a terminal or a journal that goes away
            // with us.
            psi.RedirectStandardInput = psi.RedirectStandardOutput = psi.RedirectStandardError = true;
        }
        // The working directory must not be the install folder, or it can't be mirrored over.
        psi.WorkingDirectory = Path.GetDirectoryName(script)!;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;

        var proc = Process.Start(psi) ?? throw new InvalidOperationException($"{psi.FileName} did not start");
        // Nothing here waits on it: this process is about to exit and the updater must outlive it.
        if (!OperatingSystem.IsWindows())
        {
            try { proc.StandardInput.Close(); } catch { }
            try { proc.StandardOutput.Close(); } catch { }
            try { proc.StandardError.Close(); } catch { }
        }
        proc.Dispose();
    }

    private static bool SamePath(string a, string b) =>
        string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(a)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(b)),
            StringComparison.OrdinalIgnoreCase);

    public override void Dispose()
    {
        _watcher?.Dispose();
        base.Dispose();
    }
}
