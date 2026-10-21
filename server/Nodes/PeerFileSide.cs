using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Hangar.Server.FileSystem;
using Hangar.Server.Remote;

namespace Hangar.Server.Nodes;

/// <summary>
/// The source end of a paste between machines (plans/multi-node.md, phase 6): a session's files on a paired
/// node, read through that node's API with the token this node holds for it. The paste runs on the node it
/// lands on — the panel the files are pasted into is that node's — so this side is only ever read from, and
/// deleted from at the end of a move; nothing is written to another machine through it.
/// </summary>
/// <remarks>
/// Every path goes through the peer's own endpoints, so its rules hold as they do for anyone there: the
/// session's roots confine it (BrowseRoot to read, WriteRoot to delete), and a node that doesn't take this
/// node's token any more refuses. Listings ask for hidden entries too — a copied folder keeps its
/// <c>.git</c> and dotfiles, as a paste on one machine does.
/// </remarks>
internal sealed class PeerFileSide : IFileSide, IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly OutboundPeer _peer;
    private readonly string _token;
    private readonly string _sessionId;
    private readonly string? _dir;
    private readonly HttpClient _http;
    private readonly CancellationTokenRegistration _aborted;
    // The response a copy is reading from, so leaving (the request aborted) can cut it off mid-body.
    private HttpResponseMessage? _reading;
    // One listing per folder for the length of a paste: Exists/IsDir/ListNames all ask the parent's.
    private readonly Dictionary<string, PeerListing?> _listings = new(StringComparer.Ordinal);

    /// <summary>A peer's listing, and whether its hidden entries are in it — see <see cref="List"/>.</summary>
    private sealed record PeerListing(string Path, IReadOnlyList<FileEntry> Entries, bool IncludesHidden);

    // A body that sends nothing for this long is a peer that has gone (asleep, off the network) — not one
    // that is slow, which still sends something.
    private static readonly TimeSpan Idle = TimeSpan.FromSeconds(60);

    /// <param name="ct">The paste's request: leaving it stops whatever is being read.</param>
    public PeerFileSide(OutboundPeer peer, string token, string sessionId, string? dir, CancellationToken ct)
    {
        _peer = peer;
        _token = token;
        _sessionId = sessionId;
        _dir = string.IsNullOrEmpty(dir) ? null : dir;
        // Long enough for a large file's headers to come back; the body streams after, unbounded by it.
        _http = new HttpClient(PeerHttp.CreateHandler(peer.Fingerprint), disposeHandler: true)
        {
            Timeout = TimeSpan.FromSeconds(60),
        };
        _aborted = ct.Register(() =>
        {
            _http.CancelPendingRequests();
            _reading?.Dispose();
        });
    }

    public string Key => $"node:{_peer.Id}:{_sessionId}:{_dir}";
    public string Identity(string path) => $"{Key}:/{Norm(path)}";
    public bool IsTop(string path) => Norm(path).Length == 0;

    public string Join(string dir, string name) => Norm(dir) is { Length: > 0 } d ? d + "/" + name : name;
    public string Parent(string path) => Norm(path) is var p && p.LastIndexOf('/') is var i && i > 0 ? p[..i] : "";
    public string NameOf(string path) => Norm(path) is var p && p.LastIndexOf('/') is var i && i >= 0 ? p[(i + 1)..] : p;
    public bool IsUnder(string path, string ancestor)
    {
        var (p, a) = (Norm(path), Norm(ancestor));
        return a.Length == 0 || p == a || p.StartsWith(a + "/", StringComparison.Ordinal);
    }

    public bool Exists(string path) => IsTop(path) || Entry(path) is not null;
    public bool IsDir(string path) => IsTop(path) || Entry(path)?.IsDir == true;

    public IEnumerable<string> ListNames(string dir) =>
        (List(Norm(dir)) ?? throw new RemoteException("That folder isn't there any more.")).Entries.Select(e => e.Name);

    public Stream OpenRead(string path)
    {
        var request = Request(HttpMethod.Get, $"fs/raw?{Query(("path", Norm(path)), ("download", "true"))}");
        var response = _http.Send(request, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode)
        {
            using (response) throw Failure(response);
        }
        _reading = response;
        return new OwningStream(response.Content.ReadAsStream(), response, Idle);
    }

    public void Delete(string path)
    {
        using var request = Request(HttpMethod.Post, "fs/delete");
        request.Content = JsonContent.Create(new { path = Norm(path), dir = _dir }, options: Json);
        using var response = _http.Send(request);
        if (!response.IsSuccessStatusCode)
            throw new RemoteException($"Copied, but could not remove it from {_peer.Name}: {Said(response) ?? $"it answered {(int)response.StatusCode}"}.");
    }

    public Stream Create(string path) => throw new RemoteException("Files are pasted on the machine the panel is on.");
    public void Mkdir(string path) => throw new RemoteException("Files are pasted on the machine the panel is on.");
    public bool TryMove(string from, string to) => false;
    public bool TryCopy(string from, string to) => false;

    public void Dispose()
    {
        _aborted.Dispose();
        _http.Dispose();
    }

    private FileEntry? Entry(string path)
    {
        var name = NameOf(path);
        return List(Parent(path))?.Entries.FirstOrDefault(e => e.Name == name);
    }

    /// <remarks>
    /// A build from before copies between machines ignores <c>?all=true</c> and lists no hidden entries: a copy
    /// of a folder from it would quietly leave out its <c>.git</c> and dotfiles — and a move would then delete
    /// them with the folder. Such a listing is refused rather than copied from.
    /// </remarks>
    private PeerListing? List(string dir)
    {
        if (_listings.TryGetValue(dir, out var cached)) return cached;
        using var request = Request(HttpMethod.Get, $"fs/list?{Query(("path", dir), ("all", "true"))}");
        using var response = _http.Send(request);
        PeerListing? listing = null;
        if (response.IsSuccessStatusCode)
        {
            using var body = response.Content.ReadAsStream();
            listing = JsonSerializer.Deserialize<PeerListing>(body, Json);
            if (listing is { IncludesHidden: false })
                throw new RemoteException($"{_peer.Name} runs an older build, which can't copy hidden files (.git, dotfiles). Update it first.");
        }
        else if (response.StatusCode != HttpStatusCode.NotFound) throw Failure(response);
        _listings[dir] = listing;
        return listing;
    }

    private HttpRequestMessage Request(HttpMethod method, string rest)
    {
        var url = $"{_peer.Url}/api/sessions/{Uri.EscapeDataString(_sessionId)}/{rest}";
        if (_dir is not null && method == HttpMethod.Get) url += $"&dir={Uri.EscapeDataString(_dir)}";
        var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new("Bearer", _token);
        return request;
    }

    private Exception Failure(HttpResponseMessage response) => response.StatusCode switch
    {
        HttpStatusCode.NotFound => new RemoteException("Not found."),
        HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => new RemoteException($"{_peer.Name} no longer accepts this machine."),
        var status => new RemoteException($"{_peer.Name}: {Said(response) ?? $"it answered {(int)status}"}."),
    };

    /// <summary>The peer's own words for why, when it gave some (<c>{ "error": "…" }</c>), cut short.</summary>
    private static string? Said(HttpResponseMessage response)
    {
        try
        {
            using var body = response.Content.ReadAsStream();
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.TryGetProperty("error", out var e) && e.GetString() is { Length: > 0 } text
                ? (text.Length > 200 ? text[..200] : text)
                : null;
        }
        catch { return null; }
    }

    private static string Query(params (string Key, string Value)[] pairs) =>
        string.Join('&', pairs.Select(p => $"{p.Key}={Uri.EscapeDataString(p.Value)}"));

    // Paths here are the peer's own — '/'-separated, from its listings and its panel — and a '\\' in one is a
    // character of a name (on Linux and macOS it is a legal one), not a separator.
    private static string Norm(string path) => path.Trim('/');

    /// <summary>
    /// A response body that lets go of its response when the copy is done with it — or when nothing has come
    /// for <c>idle</c>, which cuts the connection and ends the read with an error rather than waiting for ever.
    /// </summary>
    private sealed class OwningStream : Stream
    {
        private readonly Stream inner;
        private readonly IDisposable owner;
        private readonly TimeSpan idle;
        private readonly Timer watchdog;

        public OwningStream(Stream inner, IDisposable owner, TimeSpan idle)
        {
            this.inner = inner;
            this.owner = owner;
            this.idle = idle;
            watchdog = new Timer(_ => owner.Dispose(), null, idle, Timeout.InfiniteTimeSpan);
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer)
        {
            var n = inner.Read(buffer);
            watchdog.Change(idle, Timeout.InfiniteTimeSpan); // something came: the clock starts again
            return n;
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                watchdog.Dispose();
                inner.Dispose();
                owner.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
