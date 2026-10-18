using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Hangar.Server.Auth;

public sealed class AuthOptions
{
    /// <summary>
    /// Bootstrap-only plaintext password. Leave empty in steady state: when set, it is treated as a
    /// one-time set/rotate request — hashed to <c>%LocalAppData%\Hangar\auth.json</c> on startup
    /// and then ignored, so no recoverable secret lives in config. Clear it after the first launch.
    /// When no hash has ever been persisted and this is empty, auth is disabled (localhost dev only).
    /// </summary>
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
/// disk (<c>%LocalAppData%\Hangar\tokens.json</c>) so a browser stays logged in across an app
/// restart/redeploy instead of being bounced to the login screen.
/// </summary>
public sealed class TokenStore
{
    // Persisted tokens older than this are dropped on load, so the file can't grow without bound and
    // a long-abandoned token doesn't live forever. Comfortably longer than a typical redeploy cadence.
    private static readonly TimeSpan TokenTtl = TimeSpan.FromDays(30);

    private readonly ConcurrentDictionary<string, DateTimeOffset> _tokens = new();
    private readonly AuthOptions _options;
    private readonly ILogger<TokenStore> _logger;
    private readonly string _stateFile;
    private readonly string _authFile;
    private readonly object _saveLock = new();

    // Salted PBKDF2 hash of the login password (or null when never set). The plaintext is never
    // stored — see PasswordHasher. Persisted alongside tokens under %LocalAppData%\Hangar.
    private string? _passwordHash;

    public TokenStore(AuthOptions options, ILogger<TokenStore> logger)
    {
        _options = options;
        _logger = logger;
        var stateDir = AppDataFolder.Root;
        _stateFile = Path.Combine(stateDir, "tokens.json");
        _authFile = Path.Combine(stateDir, "auth.json");
        Load();
        LoadAuthState();

        // Mint the hook token once and keep it: sessions carry it in their environment for as long as
        // their claude process lives, which outlasts this app run (see SessionManager adoption). When
        // the auth file couldn't be used this save stands down, so the token lives in memory for this
        // run only — sessions started now work, and pick up the real one after the file is repaired.
        if (string.IsNullOrEmpty(HookToken))
        {
            HookToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            SaveAuthState();
        }

        // A plaintext Auth:Password is a one-time bootstrap/rotation input: hash it, persist the
        // hash, and warn the operator to remove the plaintext. It always wins so a rotation takes
        // effect on the next restart; steady state leaves it empty and reads the persisted hash.
        if (!string.IsNullOrEmpty(_options.Password))
        {
            _passwordHash = PasswordHasher.Hash(_options.Password);
            // An explicit bootstrap is the one thing that overrides an auth file we refused to touch:
            // the operator is telling us to set the password now, and this is the documented way back
            // in after the file goes bad. The old one is kept beside the new rather than thrown away.
            if (_authUnusable && StateFile.SetAside(_authFile, _logger, "auth")) _authUnusable = false;
            if (SaveAuthState())
                _logger.LogWarning(
                    "A plaintext Auth:Password was detected and hashed to {AuthFile}. Remove the " +
                    "plaintext Password from appsettings.json — the persisted hash is now authoritative.",
                    _authFile);
            else
                // Saying "the persisted hash is now authoritative" here would be the opposite of true,
                // and acting on it (clearing the plaintext) would lock the operator out on the next
                // restart — this is the recovery path, so it must not mislead the person walking it.
                _logger.LogWarning(
                    "A plaintext Auth:Password was detected and is in effect for this run, but it could " +
                    "NOT be written to {AuthFile}. Leave the plaintext Password in appsettings.json " +
                    "until that file can be written, or this instance comes back with no password set.",
                    _authFile);
        }
    }

    /// <summary>
    /// Whether this instance serves without a login. That is meant to describe a <b>never configured</b>
    /// install (localhost dev): no auth.json, or one that has never carried a hash.
    /// </summary>
    /// <remarks>
    /// An auth.json we could not use is emphatically <em>not</em> that, however it failed. A file that
    /// exists is evidence a password was set, and inferring "no password was ever set" from our own
    /// inability to read it would throw the doors of a public instance open to anyone — arbitrary reads
    /// and writes under <c>/api/fs</c>, and a session spawn is a shell. Both failure paths therefore
    /// fail closed: no login is accepted until a human deals with the file, which
    /// <see cref="LoadAuthState"/> logs in full. Local clients (the tray) are unaffected — they carry
    /// this run's <see cref="LocalToken"/>.
    /// </remarks>
    public bool AuthDisabled => !_authUnusable && string.IsNullOrEmpty(_passwordHash);

    /// <summary>
    /// Secret that authorizes Claude hook callbacks (<c>POST /api/hooks</c>) and a session's self-rename
    /// (<c>POST /api/self/name</c>), passed as the <c>X-Hook-Token</c> header. Injected into each
    /// launched session's environment as <c>CLAUDEWEB_HOOK_TOKEN</c>, so the static global hook config
    /// only references the env var — never the literal secret.
    /// <para>Minted once and persisted to <c>auth.json</c>, NOT per app run: a session's environment is
    /// fixed when its claude process starts, and that process outlives the app — a restart or a redeploy
    /// re-adopts the still-running session (see SessionManager adoption) but cannot re-inject anything
    /// into it. A per-run secret therefore left every surviving session holding a stale token, and its
    /// hooks and its <c>/rename-session</c> silently 401'd until it was restarted by hand.</para>
    /// </summary>
    public string HookToken { get; private set; } = "";

    /// <summary>
    /// Validate the <c>X-Hook-Token</c> header on a hook callback. Constant-time compare. Returns false
    /// for a null/empty header (a non-Hangar session, whose env var is unset, sends an empty value).
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
        // Verify against the stored salted hash (PasswordHasher does the constant-time compare).
        return PasswordHasher.Verify(password, _passwordHash) ? NewToken() : null;
    }

    public bool IsValid(string? token) =>
        AuthDisabled || (token is not null && (_tokens.ContainsKey(token) || IsLocalToken(token)));

    /// <summary>
    /// Bearer token for local clients of this daemon — the tray. Minted per run and handed out only through
    /// the instance file (<c>DaemonInstance</c>), which only this user can read. Never persisted: a client
    /// re-reads the file after a restart, so a stale copy has nothing left to unlock.
    /// </summary>
    public string LocalToken { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    /// <summary>Whether <paramref name="token"/> is this run's <see cref="LocalToken"/>. Constant-time compare.</summary>
    public bool IsLocalToken(string? token) =>
        !string.IsNullOrEmpty(token)
        && CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.UTF8.GetBytes(token), System.Text.Encoding.UTF8.GetBytes(LocalToken));

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

    // Set when tokens.json is there but couldn't be used, which makes Save() stand down for the rest of
    // the run rather than write this run's handful of tokens over a file whose contents we never saw.
    private bool _tokensUnusable;

    /// <summary>
    /// Set when auth.json is there but couldn't be used — unreadable, or unparseable. Two things turn
    /// on it: auth fails closed (see <see cref="AuthDisabled"/>), and nothing is written over the file,
    /// so whatever is in it stays put for a human to rescue or remove. Cleared only by an explicit
    /// <c>Auth:Password</c> bootstrap, which is the way back in.
    /// </summary>
    private bool _authUnusable;

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
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            // Couldn't get at it — locked, or permissions. The tokens in it are presumably still good,
            // so leave the file alone rather than replacing it with whatever this run mints.
            _logger.LogWarning(ex, "Could not read tokens from {File}; it will not be written this run", _stateFile);
            _tokens.Clear();
            _tokensUnusable = true;
        }
        catch
        {
            // Could not make sense of it: old format, or truncated by a stop mid-write. It will never
            // read any better, so set it aside and start a fresh one — the cost is a single re-login on
            // each device. Deliberately without the exception: a malformed entry makes System.Text.Json
            // name the offending JSON path, and in this file the property names ARE the bearer tokens.
            _tokens.Clear();
            _tokensUnusable = !StateFile.SetAside(_stateFile, _logger, "tokens");
        }
    }

    private void Save()
    {
        if (_tokensUnusable) return; // see Load: don't write over a file we couldn't use
        lock (_saveLock)
        {
            try { StateFile.Write(_stateFile, JsonSerializer.Serialize(_tokens)); }
            catch { /* best-effort — a failed persist just means re-login after the next restart */ }
        }
    }

    // ---- Persistence: the password hash and hook token live next to tokens.json, not in appsettings -

    private sealed class AuthState
    {
        public string? PasswordHash { get; set; }
        public string? HookToken { get; set; }
    }

    // Both fields are written together, so a save must never carry only one of them: an auth.json from
    // a build that predates the hook token simply has none, and the constructor mints one.
    private void LoadAuthState()
    {
        try
        {
            if (!File.Exists(_authFile)) return;
            var state = JsonSerializer.Deserialize<AuthState>(File.ReadAllText(_authFile));
            if (!string.IsNullOrEmpty(state?.PasswordHash)) _passwordHash = state.PasswordHash;
            if (!string.IsNullOrEmpty(state?.HookToken)) HookToken = state.HookToken;
        }
        // Both ways of failing land in the same state, and it is deliberately the inconvenient one:
        // the file is left exactly as it is, and auth fails closed until a human deals with it. Setting
        // it aside and reseeding would be friendlier and is what this used to do — but it hands the
        // instance to the internet in the meantime (see AuthDisabled), and the bytes it discards are
        // the only copy of the password hash. Auth:Password is the way back in; the logs say so.
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            _authUnusable = true;
            _logger.LogError(ex,
                "Could not read the auth file {AuthFile}. Logging in is refused until it can be read, " +
                "nothing is written over it, and hook callbacks from sessions started before now will " +
                "not authenticate. Free the file (or fix its permissions) and restart — or set a new " +
                "Auth:Password, which replaces it.", _authFile);
        }
        catch (Exception ex)
        {
            _authUnusable = true;
            _logger.LogError(ex,
                "Could not load the auth file {AuthFile}. Logging in is refused until it is dealt with, " +
                "and hook callbacks from sessions started before now will not authenticate. Restore the " +
                "file from a backup, or set Auth:Password to replace it (the old one is kept beside it).",
                _authFile);
        }
    }

    /// <returns>Whether the state reached the disk — see the bootstrap warning in the constructor.</returns>
    private bool SaveAuthState()
    {
        if (_authUnusable) return false; // see LoadAuthState: don't write over a file we couldn't use
        lock (_saveLock)
        {
            try
            {
                StateFile.Write(_authFile, JsonSerializer.Serialize(
                    new AuthState { PasswordHash = _passwordHash, HookToken = HookToken }));
                return true;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to persist auth state to {AuthFile}", _authFile);
                return false;
            }
        }
    }
}
