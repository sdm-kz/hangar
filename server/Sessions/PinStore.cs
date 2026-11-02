namespace Hangar.Server.Sessions;

/// <summary>
/// Sessions the user has pinned to the top of their folder, persisted to
/// %LocalAppData%\Hangar\pins.json so a pin follows them across every browser and device — like
/// the recents and projects, and unlike the sidebar's other view preferences, which stay per-browser.
/// Keyed by conversation, so a pin survives a reopen — see <see cref="ConversationFlagStore"/>.
/// </summary>
public sealed class PinStore(ILogger<PinStore> log) : ConversationFlagStore(log, "pins.json", "pins", "pinned sessions")
{
    /// <summary>Whether this key is pinned. A null/blank key never is.</summary>
    public bool IsPinned(string? key) => Has(key);
}

