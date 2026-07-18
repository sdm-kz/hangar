using System.Text.Json;
using WebPush;

namespace ClaudeWeb.Server.Push;

/// <summary>The VAPID keypair the server signs push messages with, plus the contact subject.</summary>
public sealed record VapidKeys(string PublicKey, string PrivateKey, string Subject);

/// <summary>
/// Holds the server's VAPID keypair, generated once on first run and persisted to
/// %LocalAppData%\ClaudeWeb\vapid.json — the same out-of-wwwroot location as the other stores, so a
/// wwwroot-only redeploy never disturbs it (regenerating would invalidate every existing browser
/// subscription). Only the public key is ever exposed to the client (via /api/push/config); the
/// private key stays on disk here. Mirrors the load/save shape of <c>RecentsStore</c>.
/// </summary>
public sealed class VapidKeyStore
{
    private readonly VapidKeys _keys;

    public VapidKeyStore(IConfiguration config, ILogger<VapidKeyStore> log)
    {
        var file = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "vapid.json");

        // The VAPID subject must be a valid mailto: or https: URL; the configured public URL fits.
        var subject = config["Push:Subject"]
            ?? config["Server:PublicUrl"]
            ?? "https://localhost/";

        _keys = Load(file, log) ?? Generate(file, subject, log);
    }

    public VapidKeys Keys => _keys;

    private static VapidKeys? Load(string file, ILogger log)
    {
        try
        {
            if (!File.Exists(file)) return null;
            var k = JsonSerializer.Deserialize<VapidKeys>(File.ReadAllText(file));
            if (k is null || string.IsNullOrWhiteSpace(k.PublicKey) || string.IsNullOrWhiteSpace(k.PrivateKey))
                return null;
            return k;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not read VAPID keys from {File}; will regenerate", file);
            return null;
        }
    }

    private static VapidKeys Generate(string file, string subject, ILogger log)
    {
        var details = VapidHelper.GenerateVapidKeys();
        var keys = new VapidKeys(details.PublicKey, details.PrivateKey, subject);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, JsonSerializer.Serialize(keys, new JsonSerializerOptions { WriteIndented = true }));
            log.LogInformation("Generated a new VAPID keypair at {File}", file);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not persist VAPID keys to {File}; push will not survive a restart", file);
        }
        return keys;
    }
}
