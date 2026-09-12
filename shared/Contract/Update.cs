// The in-app update's state as it rides the /hub/events snapshot. Shared with the tray, which must step
// aside — exit, so its exe can be replaced — the moment it reads Applying; a name kept by hand in two
// places would stop that from happening the first time one of them changed, and nothing would say so.

namespace ClaudeWeb.Contract;

/// <summary>Where an update is in its lifecycle, as far as the app that's being replaced can tell.</summary>
public enum UpdateState
{
    /// <summary>Nothing in flight. There may or may not be a staged build to offer.</summary>
    Idle,

    /// <summary>The updater has been handed off to; this app is going down and will be replaced.</summary>
    Applying,

    /// <summary>The hand-off itself failed, so this app is still the one running.</summary>
    Failed,
}
