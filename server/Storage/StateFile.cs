namespace ClaudeWeb.Server;

/// <summary>
/// The file mechanics every JSON state file in this app shares — the sessions list, the projects,
/// templates, pins, recents, per-session UI, linked folders, push subscriptions, tokens and auth.
/// They all keep something the user cannot get back by other means, and they all learned the same
/// two lessons the hard way:
///
/// <para><b>Never leave a half-written file behind.</b> A truncate-then-fill write interrupted by a
/// stop, a crash or a Windows shutdown leaves a file that parses as nothing — and the app then had
/// no way to tell that from "nothing was ever saved here", which is how a single bad moment could
/// cost every session, project or password in it.</para>
///
/// <para><b>Never write over a file we could not read.</b> Whatever is in it is presumably still
/// good; a fresh file written on top is the one thing that makes the loss permanent.</para>
/// </summary>
internal static class StateFile
{
    /// <summary>
    /// Whether a read failure means we could not <em>get at</em> the file, as opposed to not being
    /// able to make sense of what was in it. The two want opposite repairs — the first leaves the
    /// file exactly where it is and stops writing, the second sets it aside and starts over — so
    /// every store's <c>Load</c> splits its catch on this.
    /// </summary>
    /// <remarks>
    /// Keyed on access failures rather than on <see cref="System.Text.Json.JsonException"/>, because
    /// a store's own validation throws its own things: a null entry in a hand-edited file reaches a
    /// projection as a <see cref="NullReferenceException"/>, and that is a statement about the
    /// content — it must not be mistaken for a locked file and answered by never writing again.
    /// </remarks>
    public static bool IsAccessFailure(Exception ex) =>
        ex is IOException or UnauthorizedAccessException or System.Security.SecurityException;

    /// <summary>
    /// Write JSON to <paramref name="file"/> so that an interruption can only ever leave the old
    /// contents or the new ones, never a hybrid: fill a temporary file beside it, then swap that in.
    /// Throws what the write threw, having cleaned the temporary file up.
    /// </summary>
    /// <remarks>
    /// <para>The temp name carries this process's id because <c>%LocalAppData%\ClaudeWeb</c> is shared
    /// by every instance on the machine — a dev instance beside the live app writes the same state
    /// files — and two of them filling one temp file would publish each other's half-serialized bytes.</para>
    /// <para><c>File.Move(overwrite)</c> rather than <c>File.Replace</c>: it is the same atomic rename,
    /// it needs no separate "does the target exist yet" branch (and no race between asking and acting),
    /// and it still works where <c>ReplaceFile</c> refuses — a redirected <c>%LocalAppData%</c> on a
    /// network share — where the alternative is every save silently doing nothing for the life of the
    /// install. It is the same thing <c>ShellManager</c> has always done for the shells file.</para>
    /// </remarks>
    public static void Write(string file, string json)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var tmp = $"{file}.{Environment.ProcessId}.tmp";
        try
        {
            File.WriteAllText(tmp, json);
            File.Move(tmp, file, overwrite: true);
        }
        catch
        {
            // Don't leave the copy lying next to the real thing: for auth.json and vapid.json it would
            // be a second copy of a secret, and for the rest it is a file that looks like state and
            // isn't. Best-effort — if it can't be deleted there is nothing further to try.
            try { File.Delete(tmp); } catch { /* ignored */ }
            throw;
        }
    }

    /// <summary>
    /// Move a state file we can't use out of the way, keeping <em>every</em> generation of it: the
    /// bytes may still be worth a manual rescue (a truncated auth.json still holds the head of a
    /// password hash), and a second failure must not overwrite the copy the first one saved.
    /// </summary>
    /// <returns>
    /// Whether it moved. A caller that could not get the file out of the way must not write over it
    /// either — that is the one case where refusing to save for the rest of the run is exactly right.
    /// </returns>
    public static bool SetAside(string file, ILogger log, string what)
    {
        try
        {
            var aside = file + ".unreadable";
            if (File.Exists(aside)) aside = $"{file}.{DateTime.Now:yyyyMMdd-HHmmss}.unreadable";
            if (File.Exists(aside)) aside = $"{file}.{Guid.NewGuid():N}.unreadable";
            File.Move(file, aside);
            log.LogWarning("The {What} file that could not be used is kept at {Path}", what, aside);
            return true;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not set aside the unusable {What} file {File}; it will not be " +
                "written over this run", what, file);
            return false;
        }
    }
}
