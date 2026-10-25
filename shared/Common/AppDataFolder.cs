namespace Hangar;

/// <summary>
/// The app's per-user data folder: <c>%LocalAppData%\Hangar</c> on Windows, <c>~/.local/share/Hangar</c>
/// on Linux, <c>~/Library/Application Support/Hangar</c> on macOS. Every process of the app — the daemon,
/// the pty hosts, the tray — finds it here, so they agree on it by construction.
/// </summary>
/// <remarks>
/// <para><c>HANGAR_TEST_ROOT</c> stands in for %LocalAppData% when set, so a test instance gets a data
/// folder of its own. Setting <c>%LOCALAPPDATA%</c> does not do that: .NET resolves the known folder
/// through the Win32 API and ignores the variable.</para>
/// </remarks>
public static class AppDataFolder
{
    public const string Name = "Hangar";

    /// <summary>%LocalAppData% (or <c>HANGAR_TEST_ROOT</c>): the folder the data folder sits in.</summary>
    public static string Base =>
        Environment.GetEnvironmentVariable("HANGAR_TEST_ROOT") is { Length: > 0 } test
            ? test
            : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    public static string Root => Path.Combine(Base, Name);

    /// <summary>A path inside <see cref="Root"/>.</summary>
    public static string PathFor(params string[] parts) => Path.Combine([Root, .. parts]);
}
