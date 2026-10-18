using System.Text.Json;
using WebPush;

namespace Hangar.Server.Push;

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

        // A stored keypair is not ours to replace however badly it reads: it is what every push
        // subscription already out there is signed against, and a new one cuts all of them off
        // silently. So a keypair is only ever generated over a file that ISN'T there.
        var (loaded, mayWrite) = Load(file, log);
        if (loaded is not null)
        {
            _keys = loaded;
        }
        else
        {
            // Ephemeral covers both ways a generated keypair can fail to become the stored one: a file
            // we must not write over, and a write that didn't work. Either way it is gone at the next
            // start, so no browser may be handed it.
            var (keys, persisted) = Generate(file, subject, log, mayWrite);
            _keys = keys;
            Ephemeral = !persisted;
        }
    }

    public VapidKeys Keys => _keys;

    /// <summary>
    /// Whether this run is on a keypair that exists only in memory, because the stored one could not be
    /// used and must not be replaced. It matters outside this class: a browser that subscribes against
    /// an ephemeral public key is bound to a private half that will not exist after the next restart,
    /// and nothing downstream can detect that — the push fails with 403, which
    /// <c>PushNotifier</c> does not prune (it prunes 404/410), while the browser keeps reporting itself
    /// subscribed. So <c>/api/push/config</c> withholds the key while this is true: no device can
    /// subscribe during such a run, which is the only outcome that stays repairable.
    /// </summary>
    public bool Ephemeral { get; }

    /// <summary>
    /// The stored keypair, and — when there isn't one — whether a generated one may be written to the
    /// file. Any failure to use an existing file answers that with no: the private key is in there
    /// somewhere even when the JSON around it is truncated, and it is the only thing that can reach the
    /// devices already subscribed. A truncated keys file is a job for a human, not something to paper
    /// over by cutting every phone off the app.
    /// </summary>
    private static (VapidKeys? Keys, bool MayWrite) Load(string file, ILogger log)
    {
        try
        {
            if (!File.Exists(file)) return (null, true);
            var k = JsonSerializer.Deserialize<VapidKeys>(File.ReadAllText(file));
            // Parsed, but holds no usable key: there is nothing in it left to lose.
            if (k is null || string.IsNullOrWhiteSpace(k.PublicKey) || string.IsNullOrWhiteSpace(k.PrivateKey))
                return (null, true);
            return (k, true);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not use the VAPID keys in {File}, so it is left alone: this run has no " +
                "keypair to hand out, push notifications are off, and devices already subscribed keep their " +
                "registration. Restore or repair the file (or move it aside yourself to start over, which " +
                "costs every subscribed device its registration) and restart.", file);
            return (null, false);
        }
    }

    private static (VapidKeys Keys, bool Persisted) Generate(string file, string subject, ILogger log, bool persist)
    {
        var details = VapidHelper.GenerateVapidKeys();
        var keys = new VapidKeys(details.PublicKey, details.PrivateKey, subject);
        // Not persisted when there is a file we couldn't use: the stored keypair is still in there, and
        // this run keeps a working object only so nothing downstream has to cope with a null. It is
        // never handed to a browser — see Ephemeral.
        if (!persist) return (keys, false);
        try
        {
            // Swap it in rather than truncating and filling, so an interrupted write can't leave a
            // half-written keypair — which is the state that costs every subscription. See StateFile.
            StateFile.Write(file, JsonSerializer.Serialize(keys, new JsonSerializerOptions { WriteIndented = true }));
            log.LogInformation("Generated a new VAPID keypair at {File}", file);
            return (keys, true);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not persist VAPID keys to {File}; push is off this run — a device " +
                "subscribing against a keypair that dies with the process would look subscribed for ever " +
                "and never receive anything.", file);
            return (keys, false);
        }
    }
}
