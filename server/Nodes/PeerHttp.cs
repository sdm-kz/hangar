using System.Net;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Hangar.Server.Nodes;

/// <summary>What a peer's TLS handshake showed, for the pairing dialog to put in front of a person.</summary>
public sealed class CertificateSeen
{
    public string? Fingerprint { get; set; }
    public string? Subject { get; set; }
    /// <summary>Whether the OS trusts it on its own (a CA-issued certificate for this host name).</summary>
    public bool Valid { get; set; }
}

/// <summary>
/// The one place a connection to a peer is configured, and so the one place its certificate is judged.
/// </summary>
/// <remarks>
/// <para>The rule: a peer with a pinned fingerprint must present exactly that certificate. One without a pin
/// must present a certificate the OS trusts — which is what any HTTPS client does, and right for a peer behind
/// a reverse proxy with a Let's Encrypt certificate, where a pin would break on every renewal. A self-signed
/// certificate (the NAS) therefore only ever works pinned, and a pin only ever comes from a person having
/// looked at the fingerprint, or from the password-authenticated pairing call (see <see cref="NodePairing"/>).</para>
/// <para>Plain http has no certificate to judge, and needs none of this.</para>
/// </remarks>
public static class PeerHttp
{
    /// <summary>A certificate's SHA-256, as colon-separated hex — the form browsers and openssl print it in.</summary>
    public static string Fingerprint(X509Certificate cert) =>
        string.Join(':', SHA256.HashData(cert.GetRawCertData()).Select(b => b.ToString("X2")));

    /// <summary>Whether two fingerprints are the same, whatever case or separators they were written with.</summary>
    public static bool SameFingerprint(string? a, string? b) =>
        a is not null && b is not null && Bare(a) == Bare(b) && Bare(a).Length > 0;

    private static string Bare(string fingerprint) =>
        new(fingerprint.Where(Uri.IsHexDigit).Select(char.ToUpperInvariant).ToArray());

    /// <summary>
    /// A handler for one peer. <paramref name="pinned"/> is the certificate it must present (null: one the OS
    /// trusts). <paramref name="seen"/>, when given, is filled in with what was presented, accepted or not.
    /// <paramref name="acceptAny"/> takes whatever certificate comes — only for the mutual pairing's call back,
    /// whose first use is the pin (see <see cref="NodePairing"/>).
    /// </summary>
    public static SocketsHttpHandler CreateHandler(string? pinned, CertificateSeen? seen = null, bool acceptAny = false)
    {
        var handler = new SocketsHttpHandler
        {
            // A peer is on the LAN or a tailnet; a system proxy would only ever be in the way.
            UseProxy = false,
            AllowAutoRedirect = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = TimeSpan.FromSeconds(10),
            PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2),
            EnableMultipleHttp2Connections = true,
        };
        handler.SslOptions.RemoteCertificateValidationCallback = (_, cert, _, errors) =>
        {
            if (cert is null) return false;
            var fingerprint = Fingerprint(cert);
            if (seen is not null)
            {
                seen.Fingerprint = fingerprint;
                seen.Subject = cert.Subject;
                seen.Valid = errors == SslPolicyErrors.None;
            }
            if (acceptAny) return true;
            return pinned is not null ? SameFingerprint(fingerprint, pinned) : errors == SslPolicyErrors.None;
        };
        return handler;
    }

    /// <summary>An <see cref="HttpClient"/> for a short exchange with a peer (pairing, a status probe).</summary>
    public static HttpClient CreateClient(string? pinned, CertificateSeen? seen = null, bool acceptAny = false,
        TimeSpan? timeout = null) =>
        new(CreateHandler(pinned, seen, acceptAny), disposeHandler: true)
        {
            Timeout = timeout ?? TimeSpan.FromSeconds(20),
            // Every answer these exchanges expect is a few hundred bytes. The address may be anything a person
            // typed, and what answers there must not get to fill this node's memory.
            MaxResponseContentBufferSize = 1024 * 1024,
        };

    /// <summary>
    /// Whether a failed request failed on the certificate — as opposed to the peer not answering at all. The
    /// TLS layer surfaces a refused certificate as an <see cref="AuthenticationException"/> inside the request's.
    /// </summary>
    public static bool IsCertificateFailure(Exception ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
            if (e is System.Security.Authentication.AuthenticationException) return true;
        return false;
    }
}
