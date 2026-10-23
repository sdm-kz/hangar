using Renci.SshNet;
using Hangar.Server.FileSystem;

namespace Hangar.Server.Remote;

/// <summary>
/// One end of a copy or a move: a session's folder on this machine, or a remote tab's host. Paths are
/// whatever the panel on that side speaks — root-relative with forward slashes for a session's
/// files, absolute POSIX for a remote host — so a client can paste exactly what it copied.
/// </summary>
internal interface IFileSide
{
    /// <summary>Two sides with the same key are one filesystem: a move there is a rename.</summary>
    string Key { get; }
    /// <summary>
    /// What a path is, across every side: the absolute folder on this machine, or the host and path
    /// on a remote one. Two sessions whose roots overlap, or two tabs on one host, name the same
    /// thing alike — which is what "a folder pasted into itself" has to be checked against.
    /// </summary>
    string Identity(string path);
    /// <summary>The top of this side — what a move must never take, since it would delete it.</summary>
    bool IsTop(string path);
    string Join(string dir, string name);
    string Parent(string path);
    string NameOf(string path);
    /// <summary>Whether <paramref name="path"/> is <paramref name="ancestor"/> or sits under it.</summary>
    bool IsUnder(string path, string ancestor);
    bool Exists(string path);
    /// <summary>Following links — a linked folder is copied as the folder.</summary>
    bool IsDir(string path);
    IEnumerable<string> ListNames(string dir);
    Stream OpenRead(string path);
    Stream Create(string path);
    void Mkdir(string path);
    void Delete(string path);
    /// <summary>A move within this side, by rename. False = do it by copying.</summary>
    bool TryMove(string from, string to);
    /// <summary>A copy within this side, natively (cp -a). False = stream it.</summary>
    bool TryCopy(string from, string to);
}

/// <summary>Files under one of a session's roots.</summary>
internal sealed class LocalSide(string root) : IFileSide
{
    private readonly string _root = Path.GetFullPath(root);

    public string Key => "local:" + ProjectMembership.DirKey(_root);

    // Trimmed: "./" or "a/.." resolve to the root WITH a trailing separator, which would slip past
    // the "is this the root?" checks below. The drive root keeps its separator.
    private string Full(string rel) =>
        Path.TrimEndingDirectorySeparator(
            SessionFileBrowser.ResolveSafe(_root, rel) ?? throw new RemoteException("That path is outside the folder."));

    private bool IsRoot(string full) => ProjectMembership.DirKey(full) == ProjectMembership.DirKey(_root);

    public string Identity(string path) => "local:" + ProjectMembership.DirKey(Full(path));
    public bool IsTop(string path) => IsRoot(Full(path));

    public string Join(string dir, string name) => string.IsNullOrEmpty(dir.Trim('/')) ? name : dir.TrimEnd('/') + "/" + name;
    public string Parent(string path)
    {
        var i = path.TrimEnd('/').LastIndexOf('/');
        return i < 0 ? "" : path[..i];
    }
    public string NameOf(string path) => Path.GetFileName(Full(path));
    public bool IsUnder(string path, string ancestor) => ProjectMembership.Covers(Full(ancestor), Full(path));
    public bool Exists(string path) => File.Exists(Full(path)) || Directory.Exists(Full(path));
    public bool IsDir(string path) => Directory.Exists(Full(path));
    public IEnumerable<string> ListNames(string dir) =>
        Directory.EnumerateFileSystemEntries(Full(dir)).Select(p => Path.GetFileName(p)!);
    public Stream OpenRead(string path) => File.OpenRead(Full(path));
    public Stream Create(string path) => new FileStream(Full(path), FileMode.CreateNew, FileAccess.Write);
    public void Mkdir(string path) => Directory.CreateDirectory(Full(path));
    public void Delete(string path)
    {
        var full = Full(path);
        if (IsRoot(full)) throw new RemoteException("The root cannot be removed.");
        if (Directory.Exists(full)) Directory.Delete(full, recursive: true);
        else File.Delete(full);
    }
    public bool TryMove(string from, string to)
    {
        var (src, dst) = (Full(from), Full(to));
        if (IsRoot(src)) throw new RemoteException("The root cannot be moved.");
        try
        {
            if (Directory.Exists(src)) Directory.Move(src, dst);
            else File.Move(src, dst);
            return true;
        }
        catch (IOException)
        {
            return false; // another volume — copy and delete instead
        }
    }
    public bool TryCopy(string from, string to) => false;
}

/// <summary>A remote tab's host, over its SFTP channel.</summary>
internal sealed class RemoteSide(string tabId, string target, SftpClient sftp, string home, Func<SshClient?> shell) : IFileSide
{
    public string Key => "remote:" + tabId;
    public string Identity(string path) => target + ":" + Full(path);
    public bool IsTop(string path) => Full(path) == "/";

    private string Full(string path) => RemoteManager.Normalize(path, home);

    public string Join(string dir, string name) => RemoteManager.Join(Full(dir), name);
    public string Parent(string path) => RemoteManager.Parent(Full(path));
    public string NameOf(string path) => RemoteManager.NameOf(Full(path));
    public bool IsUnder(string path, string ancestor)
    {
        var (p, a) = (Full(path), Full(ancestor));
        return p == a || p.StartsWith(a.TrimEnd('/') + "/", StringComparison.Ordinal);
    }
    public bool Exists(string path) => sftp.Exists(Full(path));
    public bool IsDir(string path) => sftp.GetAttributes(Full(path)).IsDirectory;
    public IEnumerable<string> ListNames(string dir) =>
        sftp.ListDirectory(Full(dir)).Select(f => f.Name).Where(n => n is not "." and not "..").ToList();
    public Stream OpenRead(string path) => sftp.Open(Full(path), FileMode.Open, FileAccess.Read);
    public Stream Create(string path) => sftp.Open(Full(path), FileMode.CreateNew, FileAccess.Write);
    public void Mkdir(string path) => sftp.CreateDirectory(Full(path));
    public void Delete(string path)
    {
        var full = Full(path);
        if (full == "/") throw new RemoteException("The root cannot be removed.");
        RemoteManager.DeleteTree(sftp, full, 0);
    }
    public bool TryMove(string from, string to)
    {
        try
        {
            // The entry, not RenameFile: that resolves the path first, and would move what a
            // symbolic link points at instead of the link.
            RemoteManager.Entry(sftp, Full(from)).MoveTo(Full(to));
            return true;
        }
        catch (Renci.SshNet.Common.SshException)
        {
            return false; // across filesystems on the host — copy and delete instead
        }
    }
    public bool TryCopy(string from, string to)
    {
        var (src, dst) = (Full(from), Full(to));
        // Single quotes are only inert in a POSIX shell; fish reads \' inside them, and a Windows
        // host's shell is cmd.exe, where they quote nothing at all — "&" in a file name would start a
        // second command. Those take the slow, shell-free path instead.
        if (RemoteManager.IsWindowsPath(home)) return false;
        if ((src + dst).Any(c => c == '\\' || char.IsControl(c))) return false;
        var ssh = shell();
        if (ssh is null) return false;
        try
        {
            // Both paths are single-quoted words (see Quote), so nothing in a file name is ever
            // read by the remote shell as anything but part of the name.
            using var cmd = ssh.RunCommand($"cp -a -- {Quote(src)} {Quote(dst)}");
            return cmd.ExitStatus == 0;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>A POSIX single-quoted word: nothing inside is special except the quote itself.</summary>
    private static string Quote(string s) => "'" + s.Replace("'", "'\\''") + "'";
}

/// <summary>What a paste did: where each thing landed, and what could not be copied.</summary>
public sealed record TransferResult(IReadOnlyList<string> Paths, IReadOnlyList<TransferError> Errors);
public sealed record TransferError(string Path, string Error);

/// <summary>
/// Copy or move files and folders between any two sides — within one host, between two hosts, or
/// between a host and a session's folder on this machine. Nothing is ever written over: a name that
/// is taken gets " (1)" the way an upload does, so a paste can never destroy anything.
/// </summary>
internal static class FileTransfer
{
    private const int MaxDepth = 64;

    public static TransferResult Run(IFileSide from, IReadOnlyList<string> paths, IFileSide to, string folder, bool move)
    {
        var done = new List<string>();
        var errors = new List<TransferError>();
        if (!to.Exists(folder) || !to.IsDir(folder))
            return new TransferResult(done, [new TransferError(folder, "The target folder is not there.")]);

        var same = from.Key == to.Key;
        foreach (var src in paths.Distinct())
        {
            try
            {
                if (!from.Exists(src)) throw new RemoteException("It is no longer there.");
                // Refused before anything is copied: the delete that ends a move would refuse it too,
                // but only after a whole copy of it had been made.
                if (move && from.IsTop(src)) throw new RemoteException("The root cannot be moved.");
                // Moving something into the folder it is already in changes nothing.
                if (same && move && SameDir(to, from.Parent(src), folder))
                {
                    done.Add(src);
                    continue;
                }
                if (from.IsDir(src) && Covers(from.Identity(src), to.Identity(folder)))
                    throw new RemoteException("A folder cannot be copied into itself.");

                var target = Unique(to, folder, PlainName(from.NameOf(src)));
                if (same && move && from.TryMove(src, target))
                {
                    done.Add(target);
                    continue;
                }
                if (same && !move && from.TryCopy(src, target))
                {
                    done.Add(target);
                    continue;
                }
                CopyTree(from, src, to, target, 0);
                // It is there now, whether or not the original can be taken away: the panel has to know
                // where it went, and a second paste must not make another.
                done.Add(target);
                if (move) from.Delete(src);
            }
            catch (Exception ex)
            {
                errors.Add(new TransferError(src, Describe(ex)));
            }
        }
        return new TransferResult(done, errors);
    }

    /// <summary>
    /// Move files and folders by absolute path on this machine -- for the sidebar's Files panel, which
    /// isn't held to a session's folder. Each path goes through a side rooted at its own drive, so the
    /// rules a session's move keeps hold here too: nothing is written over, a folder never goes into
    /// itself, a drive's root never moves. Moving to another drive is a copy and a delete. The paths
    /// come back absolute, the way the panel speaks them.
    /// </summary>
    public static TransferResult MoveAbsolute(IReadOnlyList<string> paths, string folder)
    {
        var done = new List<string>();
        var errors = new List<TransferError>();
        string dst, dstRoot;
        try
        {
            dst = Path.GetFullPath(folder);
            dstRoot = Path.GetPathRoot(dst) ?? throw new ArgumentException("no root");
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return new TransferResult(done, [new TransferError(folder, "That isn't a valid folder.")]);
        }
        var to = new LocalSide(dstRoot);
        foreach (var path in paths.Distinct())
        {
            string full, srcRoot;
            try
            {
                full = Path.GetFullPath(path);
                srcRoot = Path.GetPathRoot(full) ?? throw new ArgumentException("no root");
            }
            catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
            {
                errors.Add(new TransferError(path, "That isn't a valid path."));
                continue;
            }
            var from = string.Equals(srcRoot, dstRoot, StringComparison.OrdinalIgnoreCase) ? to : new LocalSide(srcRoot);
            var r = Run(from, [RelTo(srcRoot, full)], to, RelTo(dstRoot, dst), move: true);
            // What lands is under the target's root; a path left where it was is too, being in that folder.
            done.AddRange(r.Paths.Select(p => Path.GetFullPath(Path.Combine(dstRoot, p))));
            errors.AddRange(r.Errors.Select(e => e with { Path = path }));
        }
        return new TransferResult(done, errors);
    }

    /// <summary>A path below a drive's root as a side rooted there names it: forward slashes, "" for the root.</summary>
    private static string RelTo(string root, string full)
    {
        var rel = Path.GetRelativePath(root, full);
        return rel == "." ? "" : rel.Replace(Path.DirectorySeparatorChar, '/');
    }

    /// <summary>Whether <paramref name="path"/> is <paramref name="dir"/> or under it, by identity.</summary>
    private static bool Covers(string dir, string path) =>
        path == dir || path.StartsWith(dir.TrimEnd('/') + "/", StringComparison.Ordinal);

    private static bool SameDir(IFileSide side, string a, string b) =>
        side.IsUnder(a, b) && side.IsUnder(b, a);

    private static void CopyTree(IFileSide from, string src, IFileSide to, string dst, int depth)
    {
        if (depth > MaxDepth) throw new RemoteException("Folder nesting is too deep (a link loop?).");
        if (from.IsDir(src))
        {
            to.Mkdir(dst);
            foreach (var name in from.ListNames(src))
                CopyTree(from, from.Join(src, PlainName(name)), to, to.Join(dst, PlainName(name)), depth + 1);
            return;
        }
        using var input = from.OpenRead(src);
        using var output = to.Create(dst);
        input.CopyTo(output, 256 * 1024);
    }

    /// <summary>
    /// A name as the source gave it, held to being one: a listing comes from the other end — another machine,
    /// another host — and a name like <c>../../.git/hooks/pre-commit</c> would otherwise be joined onto the
    /// target and land outside the folder it was pasted into (anywhere in the target's root).
    /// </summary>
    private static string PlainName(string name)
    {
        if (string.IsNullOrEmpty(name) || name is "." or ".." || name.IndexOfAny(['/', '\\']) >= 0
            || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new RemoteException($"\"{name}\" isn't a name a file can have here.");
        return name;
    }

    private static string Unique(IFileSide side, string dir, string name)
    {
        var target = side.Join(dir, name);
        if (!side.Exists(target)) return target;
        var dot = name.LastIndexOf('.');
        var (stem, ext) = dot > 0 ? (name[..dot], name[dot..]) : (name, "");
        for (var i = 1; ; i++)
        {
            target = side.Join(dir, $"{stem} ({i}){ext}");
            if (!side.Exists(target)) return target;
        }
    }

    private static string Describe(Exception ex) => ex switch
    {
        RemoteException or RemoteNotConnectedException => ex.Message,
        Renci.SshNet.Common.SftpPermissionDeniedException or UnauthorizedAccessException => "Permission denied.",
        Renci.SshNet.Common.SftpPathNotFoundException or FileNotFoundException or DirectoryNotFoundException => "Not found.",
        _ => ex.Message,
    };
}
