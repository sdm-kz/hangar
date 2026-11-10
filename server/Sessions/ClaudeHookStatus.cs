using System.Net.Http.Json;
using Microsoft.Extensions.Logging.Abstractions;

namespace Hangar.Server.Sessions;

/// <summary>What one <see cref="ClaudeHookStore.EnsureConfigured"/> came to.</summary>
/// <param name="State"><see cref="Ours"/>, <see cref="Elsewhere"/> or <see cref="Failed"/>.</param>
/// <param name="OwnerPort">For <see cref="Elsewhere"/>: the port the hooks point at, where something is live.</param>
public sealed record HookRegistration(string State, int? OwnerPort = null)
{
    public const string Ours = "ours";
    public const string Elsewhere = "elsewhere";
    public const string Failed = "failed";
    public const string Off = "off";
}

/// <summary>
/// The state of Hangar's hooks in <c>~/.claude/settings.json</c>, kept for the UI to show. The hooks are
/// global — one registration for every Claude Code session on the machine — and an instance that finds
/// another live one owning them stands down (see <see cref="ClaudeHookStore.EnsureConfigured"/>). Until
/// this existed it said so only in its log, and what a user saw was a chat that stayed empty and a
/// status that guessed; the UI now says why, and offers to take the hooks over.
///
/// Each read runs the check a start does, so the answer follows what happens after: another instance
/// takes the hooks (it is reported), or the owner stops for good (they are taken over, as a start would
/// have). A read that finds nothing to change writes nothing.
/// </summary>
public sealed class ClaudeHookStatus
{
    private static readonly HttpClient Probe = new() { Timeout = TimeSpan.FromSeconds(1) };

    // How long the owner's port has to stay silent before a read takes the hooks over. A restart or an
    // update of the owner is over in seconds, and a read in that window must not take the hooks from it:
    // it would come back to find them here, stand down, and show the banner from then on.
    private static readonly TimeSpan OwnerGoneFor = TimeSpan.FromSeconds(30);

    private readonly ILogger<ClaudeHookStatus> _log;
    private readonly object _gate = new();
    private int _port;
    private HookRegistration _last = new(HookRegistration.Off);
    private DateTime? _ownerSilentSince;

    public ClaudeHookStatus(ILogger<ClaudeHookStatus> log) => _log = log;

    /// <summary>Whether this instance registers hooks at all (<c>Hooks:Enabled</c>).</summary>
    public bool Enabled { get; private set; }

    /// <summary>
    /// The registration at startup. Without <paramref name="enabled"/> the state is just "off".
    /// <paramref name="force"/> (<c>Hooks:Force</c>) applies here only: forced on every read as well, two
    /// instances would take the hooks from each other a minute at a time, each sure they were its own.
    /// </summary>
    public void Start(int port, bool enabled, bool force)
    {
        lock (_gate)
        {
            _port = port;
            Enabled = enabled;
            if (enabled) _last = ClaudeHookStore.EnsureConfigured(port, _log, force);
        }
    }

    public async Task<HookStatusInfo> CurrentAsync()
    {
        HookRegistration now;
        lock (_gate)
        {
            if (Enabled)
            {
                HookRegistration next;
                if (_last is { State: HookRegistration.Elsewhere, OwnerPort: { } owner })
                {
                    // Left with the owner while it answers; taken over once it has been gone a while.
                    if (ClaudeHookStore.IsListening(owner))
                        _ownerSilentSince = null;
                    else
                        _ownerSilentSince ??= DateTime.UtcNow;
                    next = _ownerSilentSince is { } since && DateTime.UtcNow - since >= OwnerGoneFor
                        ? ClaudeHookStore.EnsureConfigured(_port, NullLogger.Instance)
                        : _last;
                }
                else
                {
                    // Quiet: the startup run already logged what it found, and this one repeats on every
                    // read. A change of state is logged below instead, once.
                    next = ClaudeHookStore.EnsureConfigured(_port, NullLogger.Instance);
                }
                if (next.State != HookRegistration.Elsewhere) _ownerSilentSince = null;
                if (next != _last)
                    _log.LogInformation("Claude hooks: {State}{Owner}", next.State,
                        next.OwnerPort is { } p ? $" (port {p} owns them)" : "");
                _last = next;
            }
            now = _last;
        }
        return await DescribeAsync(now);
    }

    /// <summary>Point the hooks here regardless of the instance live on their port.</summary>
    public async Task<HookStatusInfo> TakeOverAsync()
    {
        HookRegistration now;
        lock (_gate)
        {
            // Once: they then point here, and the reads after it keep them so until another instance is
            // chosen in the same way, which the next read here reports.
            now = _last = ClaudeHookStore.EnsureConfigured(_port, _log, force: true);
            _ownerSilentSince = null;
        }
        _log.LogInformation("Claude hooks taken over by request: {State}", now.State);
        return await DescribeAsync(now);
    }

    private async Task<HookStatusInfo> DescribeAsync(HookRegistration r) =>
        new(r.State, _port, r.OwnerPort,
            r.OwnerPort is { } owner ? await IsHangarAsync(owner) : null);

    /// <summary>
    /// Whether what listens on <paramref name="port"/> is a Hangar: it answers <c>/api/auth/config</c>,
    /// which every Hangar serves without a login. Lets the UI say "another Hangar" only when it is one.
    /// </summary>
    private static async Task<bool> IsHangarAsync(int port)
    {
        try
        {
            var body = await Probe.GetFromJsonAsync<Dictionary<string, object>>($"http://127.0.0.1:{port}/api/auth/config");
            return body?.ContainsKey("authRequired") == true;
        }
        catch
        {
            return false;
        }
    }
}

/// <param name="State">ours | elsewhere | failed | off.</param>
/// <param name="Port">This instance's port.</param>
/// <param name="OwnerPort">Where the hooks point instead, when <paramref name="State"/> is "elsewhere".</param>
/// <param name="OwnerIsHangar">Whether a Hangar answers on <paramref name="OwnerPort"/>; null when there is none.</param>
public sealed record HookStatusInfo(string State, int Port, int? OwnerPort, bool? OwnerIsHangar);
