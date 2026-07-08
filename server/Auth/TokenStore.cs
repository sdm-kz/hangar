using System.Collections.Concurrent;
using System.Security.Cryptography;

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
/// Minimal shared-password auth: a correct password mints an opaque bearer token held in memory.
/// Tokens are validated on every /api and /hub request by <see cref="TokenAuthMiddleware"/>.
/// </summary>
public sealed class TokenStore
{
    private readonly ConcurrentDictionary<string, DateTimeOffset> _tokens = new();
    private readonly AuthOptions _options;

    public TokenStore(AuthOptions options) => _options = options;

    public bool AuthDisabled => string.IsNullOrEmpty(_options.Password);

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
        if (token is not null) _tokens.TryRemove(token, out _);
    }

    private string NewToken()
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        _tokens[token] = DateTimeOffset.Now;
        return token;
    }
}
