using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace ClaudeWeb.Server.Auth;

public sealed class AuthOptions
{
    /// <summary>Shared password required to log in. If empty, auth is disabled (localhost dev only).</summary>
    public string Password { get; set; } = "";
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
