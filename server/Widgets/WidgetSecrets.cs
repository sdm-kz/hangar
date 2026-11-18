using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Hangar.Server.Widgets;

/// <summary>
/// The values a widget's Node source asks for by name (docs/design/widgets.md §6.5) — an API token, a
/// site URL — kept per node in <c>%LocalAppData%\Hangar\widget-secrets.json</c>. They belong to you or
/// to a project, not to a widget: a name is looked up in the session's project first, then in your
/// personal ones, so one personal Jira token serves everywhere and a project on another site overrides it.
/// </summary>
/// <remarks>
/// <para>On Windows each value is sealed with DPAPI for the account the daemon runs as, so the file
/// copied elsewhere — a backup, another account — reads as noise. Elsewhere there is no equivalent
/// that works without a desktop keyring, so the file is written at mode 0600, the way an SSH key is.</para>
/// <para>Nothing reads a value back out over HTTP: the endpoints set them and report which are
/// <em>missing</em>. The one consumer is the Node source, on its stdin.</para>
/// </remarks>
public sealed class WidgetSecrets
{
    private const int MaxValueLength = 8192;
    private const int MaxPerScope = 50;
    private static readonly Regex NamePattern = new("^[A-Z][A-Z0-9_]{0,63}$", RegexOptions.CultureInvariant);

    private readonly string _file;
    private readonly ILogger<WidgetSecrets> _log;
    private readonly object _lock = new();
    // scope ("personal" or "project:<id>") → name → sealed value
    private Dictionary<string, Dictionary<string, string>> _sealed = new(StringComparer.Ordinal);

    public WidgetSecrets(ILogger<WidgetSecrets> log)
    {
        _log = log;
        _file = AppDataFolder.PathFor("widget-secrets.json");
        Load();
    }

    public static bool IsValidName(string? name) => name is not null && NamePattern.IsMatch(name);

    private static string ScopeKey(string? projectId) => projectId is null ? "personal" : "project:" + projectId;

    /// <summary>The values of <paramref name="names"/> a session in <paramref name="projectId"/> gets, and the names it would not.</summary>
    public (Dictionary<string, string> Values, List<string> Missing) For(string? projectId, IEnumerable<string> names)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var missing = new List<string>();
        lock (_lock)
        {
            foreach (var name in names)
            {
                var found = (projectId is not null && Lookup(ScopeKey(projectId), name) is { } own ? own : null)
                            ?? Lookup(ScopeKey(null), name);
                if (found is null) missing.Add(name);
                else values[name] = found;
            }
        }
        return (values, missing);
    }

    /// <summary>Which of <paramref name="names"/> are set, and where: "project", "personal", or absent.</summary>
    public Dictionary<string, string?> Where(string? projectId, IEnumerable<string> names)
    {
        lock (_lock)
            return names.ToDictionary(n => n, n =>
                projectId is not null && Has(ScopeKey(projectId), n) ? "project" : Has(ScopeKey(null), n) ? "personal" : null,
                StringComparer.Ordinal);
    }

    /// <summary>Set (or with an empty value, clear) one secret. False for a bad name, an over-long value, or a full scope.</summary>
    public bool Set(string? projectId, string name, string? value)
    {
        if (!IsValidName(name) || value?.Length > MaxValueLength) return false;
        lock (_lock)
        {
            var key = ScopeKey(projectId);
            if (!_sealed.TryGetValue(key, out var scope)) _sealed[key] = scope = new(StringComparer.Ordinal);
            if (string.IsNullOrEmpty(value)) scope.Remove(name);
            else
            {
                if (!scope.ContainsKey(name) && scope.Count >= MaxPerScope) return false;
                scope[name] = Seal(value);
            }
            Save();
            return true;
        }
    }

    private bool Has(string scope, string name) => _sealed.TryGetValue(scope, out var s) && s.ContainsKey(name);

    private string? Lookup(string scope, string name)
    {
        if (!_sealed.TryGetValue(scope, out var s) || !s.TryGetValue(name, out var v)) return null;
        try { return Unseal(v); }
        catch (Exception ex) when (ex is CryptographicException or FormatException)
        {
            // Sealed by another account, or a file copied in from elsewhere: treated as not set, so the
            // user is asked again rather than the script handed noise.
            _log.LogWarning("Widget secret {Name} in {Scope} cannot be read on this account; it will be asked for again", name, scope);
            return null;
        }
    }

    private static string Seal(string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        if (OperatingSystem.IsWindows())
            bytes = ProtectedData.Protect(bytes, Entropy, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(bytes);
    }

    private static string Unseal(string stored)
    {
        var bytes = Convert.FromBase64String(stored);
        if (OperatingSystem.IsWindows())
            bytes = ProtectedData.Unprotect(bytes, Entropy, DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(bytes);
    }

    private static readonly byte[] Entropy = "Hangar.WidgetSecrets.v1"u8.ToArray();

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            _sealed = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string>>>(File.ReadAllText(_file))
                      ?? new(StringComparer.Ordinal);
            _sealed = _sealed.ToDictionary(kv => kv.Key, kv => new Dictionary<string, string>(kv.Value, StringComparer.Ordinal), StringComparer.Ordinal);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not read {File}; widget secrets will be asked for again", _file);
            _sealed = new(StringComparer.Ordinal);
        }
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            var tmp = _file + ".tmp";
            // Created owner-only before anything is written into it, on the systems where that is the
            // whole of the protection.
            if (!OperatingSystem.IsWindows())
            {
                using (File.Create(tmp)) { }
                File.SetUnixFileMode(tmp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
            File.WriteAllText(tmp, JsonSerializer.Serialize(_sealed));
            File.Move(tmp, _file, overwrite: true);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not save {File}", _file);
        }
    }
}
