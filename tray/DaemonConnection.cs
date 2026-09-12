using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ClaudeWeb.Tray;

/// <summary>
/// What the tray knows about the daemon at one moment. Immutable and replaced wholesale, so the UI thread
/// can read the latest one without a lock while the connection loop swaps in the next.
/// </summary>
/// <param name="Instance">The daemon's instance file; null when no daemon is running on this port.</param>
/// <param name="Connected">Whether the event stream is up — a live instance can still be unresponsive.</param>
internal sealed record DaemonView(
    DaemonInstance? Instance,
    bool Connected,
    IReadOnlyCollection<SessionInfo> Sessions,
    IReadOnlyList<Project> Projects,
    IReadOnlyCollection<PtyOrphanInfo> Orphans)
{
    public static readonly DaemonView Offline = new(null, false, [], [], []);
}

/// <summary>
/// The tray's link to the daemon. Finds it through its <see cref="DaemonInstance"/> file, holds the
/// <c>/hub/events</c> socket open for the live session list, and fetches the two things that stream
/// doesn't carry — projects and orphaned hosts — when the list changes. Runs entirely off the UI thread:
/// the tray reads <see cref="View"/> and hears about changes through <see cref="Changed"/>.
///
/// <para>Nothing here ever starts a daemon. At logon the daemon and the tray are launched side by side and
/// the daemon takes a few seconds to bind; a tray that "helpfully" started one in that window would race
/// it. Starting is an explicit menu action.</para>
/// </summary>
internal sealed class DaemonConnection(int port) : IDisposable
{
    // The daemon's wire format: camelCase properties, enums as their names.
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    // The hub re-sends its snapshot at least every 4 s; three missed in a row is a dead socket.
    private static readonly TimeSpan Silence = TimeSpan.FromSeconds(12);
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(2);

    // Projects and orphans are refetched when the session list changes — a session in a new folder, a
    // detach — but no more often than the first interval, since a busy list changes every second; and at
    // least every second interval, which is how a project edited in the browser reaches the menu.
    private static readonly TimeSpan ExtrasMinInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan ExtrasMaxInterval = TimeSpan.FromSeconds(30);

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;
    private volatile DaemonView _view = DaemonView.Offline;
    private volatile bool _extrasStale;
    private string? _lastFailure;

    /// <summary>The latest view of the daemon.</summary>
    public DaemonView View => _view;

    /// <summary>Raised on a background thread whenever <see cref="View"/> is replaced.</summary>
    public event Action? Changed;

    /// <summary>
    /// Raised on a background thread when the daemon reports that it is about to be replaced by an update.
    /// </summary>
    public event Action<DaemonInstance>? UpdateApplying;

    public void Start() => _loop ??= Task.Run(() => RunAsync(_cts.Token));

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            // Re-read every time round: a restarted daemon writes a new file with a new pid and token.
            var instance = DaemonInstance.Read(port);
            if (instance is { HasLoopbackUrl: false })
            {
                // The daemon never writes one of these, so the file isn't to be trusted with the token.
                LogFailureOnce($"Ignoring {DaemonInstance.PathFor(port)}: {instance.LocalUrl} is not a loopback address.");
                instance = null;
            }

            if (instance is null || !instance.ProcessAlive())
            {
                Publish(DaemonView.Offline);
            }
            else
            {
                try
                {
                    await FollowAsync(instance, ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    LogFailureOnce($"No connection to the daemon on port {port}: {ex.GetBaseException().Message}");
                }
                // Still running but not (or no longer) answering. Only published on the change, so a
                // daemon that stays unresponsive doesn't wake the UI every retry.
                if (_view.Connected || _view.Instance != instance)
                    Publish(new DaemonView(instance, false, [], [], []));
            }

            try { await Task.Delay(RetryDelay, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>Hold the event stream open until it closes, goes silent, or the tray exits.</summary>
    private async Task FollowAsync(DaemonInstance instance, CancellationToken ct)
    {
        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", $"Bearer {instance.Token}");
        var local = new Uri(instance.LocalUrl);
        // client=tray: the hub keeps its fast tick for browsers, and takes a slower one when the only
        // thing connected is this menu.
        var hub = new UriBuilder(local)
        {
            Scheme = local.Scheme == Uri.UriSchemeHttps ? "wss" : "ws",
            Path = "/hub/events",
            Query = "client=tray",
        }.Uri;
        using (var connect = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            connect.CancelAfter(TimeSpan.FromSeconds(10));
            await ws.ConnectAsync(hub, connect.Token);
        }
        TrayLog.Info($"Connected to the daemon on port {port} (pid {instance.Pid}).");
        _lastFailure = null;

        IReadOnlyList<Project> projects = [];
        IReadOnlyCollection<PtyOrphanInfo> orphans = [];
        string? fetchedFor = null;              // the session list the extras were last fetched against
        string? latest = null;                  // the session list in the newest snapshot read
        var fetchedAt = DateTime.MinValue;
        byte[]? lastFrame = null;
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();

        while (!ct.IsCancellationRequested)
        {
            message.SetLength(0);
            WebSocketReceiveResult result;
            do
            {
                // Cancelling a receive aborts the socket, which is exactly what a silent one deserves.
                using var silence = CancellationTokenSource.CreateLinkedTokenSource(ct);
                silence.CancelAfter(Silence);
                result = await ws.ReceiveAsync(buffer, silence.Token);
                if (result.MessageType == WebSocketMessageType.Close) return;
                message.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            var frame = message.GetBuffer().AsSpan(0, (int)message.Length);
            var now = DateTime.UtcNow;
            var extrasDue = fetchedAt == DateTime.MinValue
                || _extrasStale
                || now - fetchedAt >= ExtrasMaxInterval
                || (latest != fetchedFor && now - fetchedAt >= ExtrasMinInterval);
            // Most frames are the hub repeating an unchanged snapshot as a keepalive, and receiving it has
            // already done everything a keepalive is for. Unless the extras are due, there is nothing to do.
            if (!extrasDue && lastFrame is not null && frame.SequenceEqual(lastFrame)) continue;
            lastFrame = frame.ToArray();

            var snapshot = JsonSerializer.Deserialize<HubSnapshot>(frame, Json);
            if (snapshot is null) continue;

            if (snapshot.Update?.State == UpdateState.Applying)
            {
                UpdateApplying?.Invoke(instance);
                return;
            }

            var sessions = snapshot.Sessions ?? [];
            latest = Signature(sessions);
            if (extrasDue || (latest != fetchedFor && now - fetchedAt >= ExtrasMinInterval))
            {
                _extrasStale = false;
                // Each keeps its last good value when a fetch fails: a menu with slightly stale projects
                // beats one that briefly forgets them.
                projects = await TryGetAsync<List<Project>>(instance, "/api/projects", ct) ?? projects;
                orphans = await TryGetAsync<List<PtyOrphanInfo>>(instance, "/api/pty/orphans", ct) ?? orphans;
                fetchedFor = latest;
                fetchedAt = now;
            }

            Publish(new DaemonView(instance, true, sessions, projects, orphans));
        }
    }

    /// <summary>Stop every orphaned pty host, and the claude under each. Returns how many stopped.</summary>
    public async Task<int> StopOrphansAsync()
    {
        var instance = _view.Instance ?? throw new InvalidOperationException("The server is not running.");
        using var request = Request(HttpMethod.Post, instance, "/api/pty/orphans/stop");
        request.Content = JsonContent.Create(new { }, options: Json); // no id: all of them
        using var response = await _http.SendAsync(request);
        response.EnsureSuccessStatusCode();
        _extrasStale = true;
        return (await response.Content.ReadFromJsonAsync<StopOrphansReply>(Json))?.Stopped ?? 0;
    }

    /// <summary>
    /// Ask the daemon to shut down. Its sessions keep running in their pty hosts, and the next daemon to
    /// start re-attaches to them.
    /// </summary>
    public async Task StopDaemonAsync()
    {
        var instance = _view.Instance ?? throw new InvalidOperationException("The server is not running.");
        using var request = Request(HttpMethod.Post, instance, "/api/daemon/stop");
        using var response = await _http.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    private static HttpRequestMessage Request(HttpMethod method, DaemonInstance instance, string path)
    {
        var request = new HttpRequestMessage(method, new Uri(new Uri(instance.LocalUrl), path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", instance.Token);
        return request;
    }

    private async Task<T?> TryGetAsync<T>(DaemonInstance instance, string path, CancellationToken ct) where T : class
    {
        try
        {
            using var request = Request(HttpMethod.Get, instance, path);
            using var response = await _http.SendAsync(request, ct);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadFromJsonAsync<T>(Json, ct);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            TrayLog.Info($"GET {path} failed: {ex.GetBaseException().Message}");
            return null;
        }
    }

    /// <summary>What about the session list can change which projects and orphans matter.</summary>
    private static string Signature(IEnumerable<SessionInfo> sessions) =>
        string.Join('|', sessions.Select(s => $"{s.Id}:{s.State}:{s.GroupId}").Order(StringComparer.Ordinal));

    /// <summary>Log a failure once per distinct message: a daemon that stays unreachable shouldn't fill the log.</summary>
    private void LogFailureOnce(string failure)
    {
        if (failure != _lastFailure) TrayLog.Info(failure);
        _lastFailure = failure;
    }

    private void Publish(DaemonView view)
    {
        if (ReferenceEquals(view, _view)) return;
        _view = view;
        try { Changed?.Invoke(); }
        catch (Exception ex) { TrayLog.Error("A daemon view handler failed", ex); }
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _loop?.Wait(TimeSpan.FromSeconds(2)); } catch { /* it was cancelled; that's the point */ }
        _http.Dispose();
        _cts.Dispose();
    }

    /// <summary>The parts of a <c>/hub/events</c> snapshot the tray uses; the rest is ignored.</summary>
    private sealed record HubSnapshot(List<SessionInfo>? Sessions, HubUpdate? Update);

    private sealed record HubUpdate(UpdateState? State);

    private sealed record StopOrphansReply(int Stopped);
}
