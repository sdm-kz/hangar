using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;

namespace ClaudeWeb.Server.Auth;

public sealed class AuthOptions
{
    /// <summary>Shared password required to log in. If empty, auth is disabled (localhost dev only).</summary>
    public string Password { get; set; } = "";

    /// <summary>
    /// API key that authorizes the external automation endpoints (<c>/api/external/*</c>) via the
    /// <c>X-Api-Key</c> header. If empty, those endpoints are disabled.
    /// </summary>
    public string ApiKey { get; set; } = "";
}

/// <summary>
/// Minimal shared-password auth: a correct password mints an opaque bearer token. Tokens are
/// validated on every /api and /hub request by <see cref="TokenAuthMiddleware"/>, and persisted to
/// disk (<c>%LocalAppData%\ClaudeWeb\tokens.json</c>) so a browser stays logged in across an app
/// restart/redeploy instead of being bounced to the login screen.
/// </summary>
public sealed class TokenStore
{
    // Persisted tokens older than this are dropped on load, so the file can't grow without bound and
    // a long-abandoned token doesn't live forever. Comfortably longer than a typical redeploy cadence.
    private static readonly TimeSpan TokenTtl = TimeSpan.FromDays(30);

    private readonly ConcurrentDictionary<string, DateTimeOffset> _tokens = new();
    private readonly AuthOptions _options;
    private readonly string _stateFile;
    private readonly object _saveLock = new();

    public TokenStore(AuthOptions options)
    {
        _options = options;
        _stateFile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "tokens.json");
        Load();
    }

    public bool AuthDisabled => string.IsNullOrEmpty(_options.Password);

    /// <summary>
    /// Secret that authorizes Claude hook callbacks (<c>POST /api/hooks</c>), passed by the hook as the
    /// <c>X-Hook-Token</c> header. Minted fresh per app run and injected into each launched session's
    /// environment as <c>CLAUDEWEB_HOOK_TOKEN</c>, so the static global hook config only references the
    /// env var — never the literal secret — and stays valid across restarts.
    /// </summary>
    public string HookToken { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    /// <summary>
    /// Validate the <c>X-Hook-Token</c> header on a hook callback. Constant-time compare. Returns false
    /// for a null/empty header (a non-ClaudeWeb session, whose env var is unset, sends an empty value).
    /// </summary>
    public bool IsValidHookToken(string? token)
    {
        if (string.IsNullOrEmpty(token)) return false;
        var a = System.Text.Encoding.UTF8.GetBytes(token);
        var b = System.Text.Encoding.UTF8.GetBytes(HookToken);
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    public string? Login(string? password)
    {
        if (AuthDisabled) return NewToken();
        if (password is null) return null;
        // Constant-time comparison to avoid leaking password length/prefix via timing.
        var a = System.Text.Encoding.UTF8.GetBytes(password);
        var b = System.Text.Encoding.UTF8.GetBytes(_options.Password);
        return CryptographicOperations.FixedTimeEquals(a, b) ? NewToken() : null;
    }

    public bool IsValid(string? token) =>
        AuthDisabled || (token is not null && _tokens.ContainsKey(token));

    /// <summary>True when an API key is configured (external endpoints enabled).</summary>
    public bool ApiKeyEnabled => !string.IsNullOrEmpty(_options.ApiKey);

    /// <summary>
    /// Validates the <c>X-Api-Key</c> header for the external endpoints. Returns false when no key
    /// is configured, so the endpoints stay closed until a key is set. Constant-time comparison.
    /// </summary>
    public bool IsValidApiKey(string? key)
    {
        if (!ApiKeyEnabled || key is null) return false;
        var a = System.Text.Encoding.UTF8.GetBytes(key);
        var b = System.Text.Encoding.UTF8.GetBytes(_options.ApiKey);
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    public void Revoke(string? token)
    {
        if (token is not null && _tokens.TryRemove(token, out _)) Save();
    }

    private string NewToken()
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        _tokens[token] = DateTimeOffset.Now;
        Save();
        return token;
    }

    // ---- Persistence: keep issued tokens across restarts so a redeploy doesn't force re-login -----

    private void Load()
    {
        try
        {
            if (!File.Exists(_stateFile)) return;
            var saved = JsonSerializer.Deserialize<Dictionary<string, DateTimeOffset>>(File.ReadAllText(_stateFile));
            if (saved is null) return;
            var cutoff = DateTimeOffset.Now - TokenTtl;
            foreach (var (token, issued) in saved)
                if (issued > cutoff) _tokens[token] = issued; // drop stale tokens on the way in
        }
        catch { /* unreadable/old-format token file — start with none (user logs in once) */ }
    }

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_stateFile)!);
                File.WriteAllText(_stateFile, JsonSerializer.Serialize(_tokens));
            }
            catch { /* best-effort — a failed persist just means re-login after the next restart */ }
        }
    }
}
