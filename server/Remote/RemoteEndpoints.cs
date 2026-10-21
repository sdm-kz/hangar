using Hangar.Server.FileSystem;
using Hangar.Server.Sessions;

namespace Hangar.Server.Remote;

internal record RemotePathRequest(string? Path);
internal record RemoteRenameRequest(string? Path, string? NewName);
internal record RemoteWriteRequest(string? Path, string? Content);
/// <summary>
/// One end of a paste: <c>Kind</c> "remote" names a <c>Tab</c>; "session" a session and its root — on the
/// node named by <c>Node</c>, when that is a paired one rather than this (see <see cref="Nodes.PeerFileSide"/>).
/// </summary>
internal record TransferSideRequest(string? Kind, string? Tab = null, string? SessionId = null, string? Dir = null,
    string? Node = null);
internal record TransferRequest(TransferSideRequest? From, List<string>? Paths, TransferSideRequest? To, string? Folder, bool Move = false);

/// <summary>
/// The remote files tabs' API: connect a tab over SSH, browse and edit the host over SFTP, and paste
/// between any two panels. Everything here sits behind the same bearer token as the rest of /api —
/// the raw-file GET takes it as <c>?access_token=</c> so an &lt;img&gt; can load through it, exactly
/// like the local file endpoints.
///
/// <para>Errors come back as <c>{ error }</c> with 400, or with 409 and <c>notConnected: true</c> when
/// the tab has no live connection it could reopen on its own — the panel's cue to show the connect
/// form again rather than an error.</para>
/// </summary>
internal static class RemoteEndpoints
{
    private const long MaxUploadBytes = 4L * 1024 * 1024 * 1024;

    public static void Map(WebApplication app)
    {
        // What the connect dialog offers: the server user's ~/.ssh/config aliases and key files.
        app.MapGet("/api/remote/ssh-config", () => Results.Ok(new
        {
            hosts = SshConfigFile.Aliases(),
            keys = SshConfigFile.DefaultKeys(),
            sshDir = SshConfigFile.SshDir,
        }));

        app.MapPost("/api/remote/{tab}/connect", async (string tab, RemoteConnectRequest body, RemoteManager remotes, CancellationToken ct) =>
            Results.Ok(await remotes.ConnectAsync(tab, body, ct)));

        app.MapGet("/api/remote/{tab}", (string tab, RemoteManager remotes) => Results.Ok(remotes.Status(tab)));

        app.MapDelete("/api/remote/{tab}", (string tab, RemoteManager remotes) =>
        {
            remotes.Disconnect(tab);
            return Results.Ok();
        });

        app.MapGet("/api/remote/{tab}/list", (string tab, string? path, RemoteManager remotes) =>
            Guard(() => Results.Ok(remotes.List(tab, path))));

        app.MapGet("/api/remote/{tab}/file", (string tab, string path, bool? download, RemoteManager remotes, HttpContext http) =>
            Guard(() =>
            {
                var (stream, _, name) = remotes.OpenRead(tab, path);
                http.Response.Headers.CacheControl = "no-cache";
                http.Response.Headers.XContentTypeOptions = "nosniff";
                var contentType = SessionFileBrowser.ContentType(name);
                // An SVG from another machine, opened on its own (an image's "open in new tab"),
                // would run its scripts at this app's origin, with the token in reach. Sandboxed, it
                // still draws.
                if (contentType == "image/svg+xml") http.Response.Headers.ContentSecurityPolicy = "sandbox";
                // Held for as long as the bytes are streaming, so the idle sweep does not cut a long
                // download off half way.
                return Results.Stream(new HeldStream(stream, remotes.Hold(tab)), contentType,
                    fileDownloadName: download == true ? name : null, enableRangeProcessing: true);
            }));

        app.MapPost("/api/remote/{tab}/write", (string tab, RemoteWriteRequest body, RemoteManager remotes) =>
            Guard(() =>
            {
                remotes.WriteText(tab, Required(body.Path), body.Content ?? "");
                return Results.Ok();
            }));

        app.MapPost("/api/remote/{tab}/mkdir", (string tab, RemotePathRequest body, RemoteManager remotes) =>
            Guard(() => Results.Ok(new { path = remotes.Mkdir(tab, Required(body.Path)) })));

        app.MapPost("/api/remote/{tab}/new-file", (string tab, RemotePathRequest body, RemoteManager remotes) =>
            Guard(() => Results.Ok(new { path = remotes.NewFile(tab, Required(body.Path)) })));

        app.MapPost("/api/remote/{tab}/rename", (string tab, RemoteRenameRequest body, RemoteManager remotes) =>
            Guard(() => Results.Ok(new { path = remotes.Rename(tab, Required(body.Path), body.NewName ?? "") })));

        app.MapPost("/api/remote/{tab}/delete", (string tab, RemotePathRequest body, RemoteManager remotes) =>
            Guard(() =>
            {
                remotes.Delete(tab, Required(body.Path));
                return Results.Ok();
            }));

        // Files from the browser into a remote folder (multipart: "path" = the folder, then "files").
        app.MapPost("/api/remote/{tab}/upload", async (string tab, HttpRequest req, RemoteManager remotes) =>
        {
            if (!req.HasFormContentType) return Results.BadRequest(new { error = "expected multipart form" });
            var form = await req.ReadFormAsync();
            var folder = form["path"].ToString();
            if (string.IsNullOrWhiteSpace(folder)) return Results.BadRequest(new { error = "no target folder" });
            if (form.Files.Count == 0) return Results.BadRequest(new { error = "no files" });
            return Guard(() =>
            {
                var paths = new List<string>();
                foreach (var file in form.Files)
                {
                    using var stream = file.OpenReadStream();
                    paths.Add(remotes.Upload(tab, folder, file.FileName, stream));
                }
                return Results.Ok(new { paths });
            });
        })
        .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(MaxUploadBytes))
        .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestFormLimitsAttribute { MultipartBodyLengthLimit = MaxUploadBytes });

        // Paste: copy or move between any two panels — a remote tab, or a session's own files. See
        // FileTransfer. Runs to completion in the request, which is the progress indicator the panel
        // shows; a paste of a large tree takes as long as the bytes take.
        app.MapPost("/api/transfer", (TransferRequest body, RemoteManager remotes, SessionManager mgr, LinkedFolderStore links,
            Nodes.PeerStore peers, Nodes.NodeIdentityStore identity, HttpContext ctx) =>
            Guard(() =>
            {
                if (body.Paths is not { Count: > 0 }) return Results.BadRequest(new { error = "nothing to paste" });
                if (body.Folder is null) return Results.BadRequest(new { error = "no target folder" });
                // The paste lands here: the files may come from another machine, but are written on this one.
                if (Elsewhere(body.To, identity))
                    return Results.BadRequest(new { error = "Files are pasted on the machine the panel is on." });
                // One hop, as everywhere between nodes (NodeProxy): asked by another node, this one reads back from
                // that node only — never on to a third, with its own token for it, on that node's say-so.
                if (Elsewhere(body.From, identity) && Auth.TokenAuthMiddleware.PeerOf(ctx) is { } caller
                    && body.From!.Node != caller.NodeId)
                    return Results.BadRequest(new { error = "Those are on a third machine. Paste them on one paired with both." });
                var from = Elsewhere(body.From, identity)
                    ? PeerSide(body.From!, peers, ctx.RequestAborted)
                    : Side(body.From, write: body.Move, remotes, mgr, links);
                using var ownFrom = from as IDisposable;
                var to = Side(body.To, write: true, remotes, mgr, links);
                using var holdFrom = body.From is { Kind: "remote", Tab: { } a } && !Elsewhere(body.From, identity) ? remotes.Hold(a) : null;
                using var holdTo = body.To is { Kind: "remote", Tab: { } b } ? remotes.Hold(b) : null;
                return Results.Ok(FileTransfer.Run(from, body.Paths, to, body.Folder, body.Move));
            }));
    }

    /// <summary>Whether a side of a paste is on another node than this one.</summary>
    private static bool Elsewhere(TransferSideRequest? s, Nodes.NodeIdentityStore identity) =>
        !string.IsNullOrEmpty(s?.Node) && s.Node != identity.Current.Id;

    /// <summary>
    /// A session's files on a paired node — the only thing on another node a paste can come from. An SSH tab's
    /// connection is held by the node it was opened on, and isn't something to reach through it.
    /// </summary>
    private static IFileSide PeerSide(TransferSideRequest s, Nodes.PeerStore peers, CancellationToken ct)
    {
        if (s.Kind != "session" || s.SessionId is null)
            throw new RemoteException("From another machine, only a session's files can be pasted.");
        if (peers.Get(s.Node!) is not { Enabled: true } peer)
            throw new RemoteException("This machine isn't paired with the one those were copied on.");
        var token = peers.TokenFor(peer.Id) ?? throw new RemoteException($"This machine's token for {peer.Name} can't be read; pair it again.");
        return new Nodes.PeerFileSide(peer, token, s.SessionId, s.Dir, ct);
    }

    private static IFileSide Side(TransferSideRequest? s, bool write, RemoteManager remotes, SessionManager mgr, LinkedFolderStore links)
    {
        switch (s?.Kind)
        {
            case "remote" when s.Tab is not null:
                return remotes.Side(s.Tab);
            case "session" when s.SessionId is not null:
                var info = mgr.GetAny(s.SessionId) ?? throw new RemoteException("That session is gone.");
                // A move takes things away from the source, so it needs the same write rights a delete
                // would; a copy only reads, so another worktree of the repo is fine to copy out of.
                var root = (write ? Program.WriteRoot(info, s.Dir, links) : Program.BrowseRoot(info, s.Dir, links))
                           ?? throw new RemoteException(write ? "That folder cannot be written to." : "Unknown folder.");
                return new LocalSide(root);
            default:
                throw new RemoteException("Unknown side of the paste.");
        }
    }

    /// <summary>A stream that lets go of a hold on its tab when the response is done with it.</summary>
    private sealed class HeldStream(Stream inner, IDisposable hold) : Stream
    {
        public override bool CanRead => inner.CanRead;
        public override bool CanSeek => inner.CanSeek;
        public override bool CanWrite => false;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => inner.Position = value; }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
            inner.ReadAsync(buffer, offset, count, ct);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) =>
            inner.ReadAsync(buffer, ct);
        public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
                hold.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    private static string Required(string? path) =>
        string.IsNullOrWhiteSpace(path) ? throw new RemoteException("No path given.") : path;

    private static IResult Guard(Func<IResult> op)
    {
        try
        {
            return op();
        }
        catch (RemoteNotConnectedException ex)
        {
            return Results.Json(new { error = ex.Message, notConnected = true }, statusCode: StatusCodes.Status409Conflict);
        }
        catch (RemoteException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
        catch (Renci.SshNet.Common.SftpPermissionDeniedException)
        {
            return Results.BadRequest(new { error = "Permission denied." });
        }
        catch (Renci.SshNet.Common.SftpPathNotFoundException)
        {
            return Results.NotFound(new { error = "No such file or folder." });
        }
        catch (Exception ex) when (ex is Renci.SshNet.Common.SshException or IOException or UnauthorizedAccessException)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
    }
}
