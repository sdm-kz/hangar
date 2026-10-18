namespace Hangar;

/// <summary>
/// The app's per-user data folder: <c>%LocalAppData%\Hangar</c> on Windows, <c>~/.local/share/Hangar</c>
/// on Linux, <c>~/Library/Application Support/Hangar</c> on macOS. Every process of the app — the daemon,
/// the pty hosts, the tray — finds it here, so they agree on it by construction.
/// </summary>
/// <remarks>
/// <para>Until the rename the folder was <c>ClaudeWeb</c> (<see cref="LegacyRoot"/>). The daemon copies
/// the stores across on start (<c>LegacyDataMigration</c>), but some things can't move: a pty host
/// started by an older build keeps writing its state file, log and socket where that build told it to,
/// and outlives the daemon on purpose. Those readers look in both folders until no such host is left.</para>
/// <para><c>HANGAR_TEST_ROOT</c> stands in for %LocalAppData% when set, so a test instance gets a data
/// folder of its own. Setting <c>%LOCALAPPDATA%</c> does not do that: .NET resolves the known folder
/// through the Win32 API and ignores the variable.</para>
/// </remarks>
public static class AppDataFolder
{
    public const string Name = "Hangar";
    public const string LegacyName = "ClaudeWeb";

    /// <summary>%LocalAppData% (or <c>HANGAR_TEST_ROOT</c>): the folder both data folders sit in.</summary>
    public static string Base =>
        Environment.GetEnvironmentVariable("HANGAR_TEST_ROOT") is { Length: > 0 } test
            ? test
            : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    public static string Root => Path.Combine(Base, Name);

    /// <summary>The folder from before the rename. Read only, by code that still has to find an older build's files.</summary>
    public static string LegacyRoot => Path.Combine(Base, LegacyName);

    /// <summary>A path inside <see cref="Root"/>.</summary>
    public static string PathFor(params string[] parts) => Path.Combine([Root, .. parts]);

    /// <summary>The same path inside <see cref="LegacyRoot"/>.</summary>
    public static string LegacyPathFor(params string[] parts) => Path.Combine([LegacyRoot, .. parts]);
}
