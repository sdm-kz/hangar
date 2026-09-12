using System.Diagnostics;
using System.Reflection;
using Microsoft.Extensions.Hosting.WindowsServices;

namespace ClaudeWeb.Server.Update;

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
                var available = _options.Enabled
                    && _staged is not null
                    && _staged.BuildId != _current?.BuildId;
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

        if (staged is not null && staged.BuildId != _current?.BuildId)
            _log.LogInformation("Update staged: {BuildId} (running {Current}).", staged.BuildId, _current?.BuildId ?? "unknown");
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
            if (string.IsNullOrWhiteSpace(_installPath)) return Fail("could not work out the install folder");
            if (!File.Exists(Path.Combine(_installPath, "ClaudeWeb.exe")))
                return Fail($"'{_installPath}' is not a Claude Web install (no ClaudeWeb.exe) — this looks like a dev run");
            if (!File.Exists(Path.Combine(_payloadPath, "ClaudeWeb.exe")))
                return Fail("the staged build has no ClaudeWeb.exe");
            if (SamePath(_installPath, _payloadPath))
                return Fail("the staging folder is the install folder — nothing to copy");

            try
            {
                var script = ExtractUpdater();
                var mode = OperatingSystem.IsWindows() && WindowsServiceHelpers.IsWindowsService() ? "service" : "process";
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
            _staged is not null && _staged.BuildId != _current?.BuildId,
            _current, _staged, _state, _error);
        Task.Run(() => Changed?.Invoke());
        return status;
    }

    /// <summary>
    /// Write the embedded apply-update.ps1 out where it can run. Deliberately NOT in the install
    /// folder — the script mirrors over that folder, so it would be replacing the file it's executing.
    /// </summary>
    private static string ExtractUpdater()
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeWeb", "update");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "apply-update.ps1");

        using var src = Assembly.GetExecutingAssembly().GetManifestResourceStream(UpdaterResourceName)
            ?? throw new InvalidOperationException($"'{UpdaterResourceName}' is missing from the build");
        using var dst = File.Create(path);
        src.CopyTo(dst);
        return path;
    }

    private const string UpdaterResourceName = "ClaudeWeb.Server.apply-update.ps1";

    private void StartUpdater(string script, string mode)
    {
        var psi = new ProcessStartInfo("powershell.exe")
        {
            // The working directory must not be the install folder, or robocopy can't mirror it.
            WorkingDirectory = Path.GetDirectoryName(script)!,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
                 {
                     "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                     "-File", script,
                     "-Staging", _payloadPath,
                     "-Target", _installPath!,
                     "-ProcessId", Environment.ProcessId.ToString(),
                     "-Mode", mode,
                     "-WaitSeconds", Math.Max(10, _options.ShutdownWaitSeconds).ToString(),
                 })
            psi.ArgumentList.Add(arg);

        var proc = Process.Start(psi) ?? throw new InvalidOperationException("powershell.exe did not start");
        // Nothing here waits on it: this process is about to exit and the updater must outlive it.
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
