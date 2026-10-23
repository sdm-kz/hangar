// The in-app update's state as it rides the /hub/events snapshot. The tray app (tray/src-tauri/src/server.rs)
// matches the name "Applying" to step aside — on Windows it exits, so its exe can be replaced — and
// nothing would say so if the two stopped agreeing: rename it there too, or the update fails to copy over
// a tray that is still running.

namespace Hangar.Contract;

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
