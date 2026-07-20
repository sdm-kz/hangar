using System.Security.Cryptography;

namespace ClaudeWeb.Server.Auth;

/// <summary>
/// Salted PBKDF2 (HMAC-SHA256) password hashing. The login password is only ever *verified*,
/// never needed in plaintext, so we store just a non-reversible hash — a leaked config/repo no
/// longer yields a usable credential. The encoded form is self-describing
/// (<c>pbkdf2$&lt;iterations&gt;$&lt;base64 salt&gt;$&lt;base64 subkey&gt;</c>) so the salt and cost
/// travel with the hash and can be tuned later without invalidating existing hashes.
/// </summary>
public static class PasswordHasher
{
    private const int Iterations = 100_000;
    private const int SaltBytes = 16;
    private const int SubkeyBytes = 32;
    private static readonly HashAlgorithmName Algorithm = HashAlgorithmName.SHA256;

    /// <summary>Hash a password with a fresh random salt. Returns the encoded string to persist.</summary>
    public static string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var subkey = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, Algorithm, SubkeyBytes);
        return $"pbkdf2${Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(subkey)}";
    }

    /// <summary>
    /// Verify a candidate password against an encoded hash. Constant-time compare on the subkey;
    /// returns false for any malformed/empty encoded value rather than throwing.
    /// </summary>
    public static bool Verify(string password, string? encoded)
    {
        if (string.IsNullOrEmpty(encoded)) return false;
        var parts = encoded.Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2") return false;
        if (!int.TryParse(parts[1], out var iterations) || iterations < 1) return false;

        byte[] salt, expected;
        try
        {
            salt = Convert.FromBase64String(parts[2]);
            expected = Convert.FromBase64String(parts[3]);
        }
        catch (FormatException) { return false; }

        var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, Algorithm, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
}
