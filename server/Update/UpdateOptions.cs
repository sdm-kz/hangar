namespace Hangar.Server.Update;

/// <summary>Tunables for the in-app updater (bound from the "Update" config section).</summary>
public sealed class UpdateOptions
{
    /// <summary>
    /// Master switch. When false nothing is watched, the UI never offers an update, and the apply
    /// endpoint refuses — the app can then only be updated by running scripts\deploy.ps1 by hand.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Folder scripts\stage-update.ps1 (stage-update.sh on Linux and macOS) publishes into. The staged build itself lives in the
    /// "payload" subfolder; this is the folder that holds it.
    /// </summary>
    public string StagingPath { get; set; } = OperatingSystem.IsWindows()
        ? @"C:\apps\claude-web-updates"
        // ~/.local/share/ClaudeWeb/updates (Linux), ~/Library/Application Support/ClaudeWeb/updates (macOS).
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeWeb", "updates");

    /// <summary>
    /// How often to re-read the staged build stamp. A FileSystemWatcher already reacts within a
    /// moment of a staging run; this poll only covers what it can miss (a network share, a watcher
    /// that dies with its buffer overflowed).
    /// </summary>
    public int PollSeconds { get; set; } = 30;

    /// <summary>
    /// Install folder to update. Empty (the default) means the folder the running exe sits in, which
    /// is what you want unless the app is being driven from somewhere unusual.
    /// </summary>
    public string? InstallPath { get; set; }

    /// <summary>Seconds the updater lets this app close on its own before forcing it down.</summary>
    public int ShutdownWaitSeconds { get; set; } = 45;
}
