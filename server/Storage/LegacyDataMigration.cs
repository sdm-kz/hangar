using System.Text.Json;

namespace Hangar.Server;

/// <summary>
/// Brings the stores over from the data folder's name from before the rename
/// (<see cref="AppDataFolder.LegacyRoot"/>) into <see cref="AppDataFolder.Root"/>: the sessions list,
/// projects, pins, schedules, templates, recents, per-session UI, linked folders, push subscriptions,
/// the VAPID keys, the password hash and the login tokens — every JSON file at the top of the folder.
/// </summary>
/// <remarks>
/// <para><b>Copied, not moved.</b> The old folder can't go anyway — a pty host an older build started
/// runs its binary from it and logs into it — and leaving the files there keeps a rollback to an older
/// build working with the data it had.</para>
/// <para><b>Run on every start, not once.</b> The data folder is shared by every instance on the
/// machine, so a test instance of this build can run while the live app is still an older one and goes
/// on writing the old folder. A copy taken then would be stale by the time the live app switches over.
/// So each file's copy remembers the old file's write time (<see cref="MarkerName"/>), and a file an
/// older build has written since is copied again. Nothing here ever writes the old folder, so once no
/// older build runs, this settles into a no-op. A file that exists here but was never copied — one this
/// build made itself — is never overwritten.</para>
/// </remarks>
internal static class LegacyDataMigration
{
    /// <summary>What was copied when: file name → the old file's last write time (UTC ticks).</summary>
    private const string MarkerName = "migrated-from-ClaudeWeb.json";

    /// <summary>
    /// Copy what needs copying. Runs before the app is built, so it has no logger: it returns what to
    /// log instead. Never throws — a file it can't copy is reported, and the store starts from what is
    /// here.
    /// </summary>
    public static IReadOnlyList<string> Run()
    {
        var report = new List<string>();
        try
        {
            var legacy = AppDataFolder.LegacyRoot;
            if (!Directory.Exists(legacy)) return report;
            var root = AppDataFolder.Root;
            Directory.CreateDirectory(root);

            // Two instances starting together must not both copy, or write the marker over each other.
            using var gate = AcquireLock(Path.Combine(root, ".migration.lock"));
            if (gate is null)
            {
                report.Add("Skipped copying data from the old folder: another instance held the migration lock.");
                return report;
            }

            var markerPath = Path.Combine(root, MarkerName);
            var copied = ReadMarker(markerPath);
            var changed = false;
            foreach (var source in Directory.EnumerateFiles(legacy, "*.json"))
            {
                var name = Path.GetFileName(source);
                var target = Path.Combine(root, name);
                var written = File.GetLastWriteTimeUtc(source).Ticks;
                var due = !File.Exists(target)
                    || (copied.TryGetValue(name, out var copiedFrom) && written > copiedFrom);
                if (!due) continue;
                try
                {
                    // Through a temp file, as every store writes: a copy cut short must not stand in for the file.
                    var tmp = $"{target}.{Environment.ProcessId}.tmp";
                    File.Copy(source, tmp, overwrite: true);
                    File.Move(tmp, target, overwrite: true);
                    copied[name] = written;
                    changed = true;
                    report.Add($"Copied {name} from {legacy}.");
                }
                catch (Exception ex) { report.Add($"Could not copy {name} from {legacy}: {ex.Message}"); }
            }
            if (changed) File.WriteAllText(markerPath, JsonSerializer.Serialize(copied));
        }
        catch (Exception ex) { report.Add($"Could not copy data from the old folder: {ex.Message}"); }
        return report;
    }

    private static Dictionary<string, long> ReadMarker(string path)
    {
        try
        {
            if (File.Exists(path))
                return JsonSerializer.Deserialize<Dictionary<string, long>>(File.ReadAllText(path))
                       ?? [];
        }
        catch { /* unreadable: start over, which only re-copies files an older build wrote since */ }
        return [];
    }

    /// <summary>An exclusive handle on <paramref name="path"/>, waited for a few seconds; null if it never came.</summary>
    private static FileStream? AcquireLock(string path)
    {
        for (var attempt = 0; attempt < 50; attempt++)
        {
            try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { Thread.Sleep(100); }
        }
        return null;
    }
}
