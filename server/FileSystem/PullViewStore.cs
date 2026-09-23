using System.Text.Json;

namespace ClaudeWeb.Server.FileSystem;

/// <summary>
/// Which files of a pull request the user has marked as read, persisted to
/// %LocalAppData%\ClaudeWeb\pr-viewed.json.
///
/// <para>Keyed by <b>repo and pull request number</b> rather than by session, because that is what
/// the mark is about. Reviewing #42 is the same piece of work whichever terminal happens to be open
/// beside it, so the marks survive a session being closed and reopened, and every session in the
/// same repo sees the same ones. It is also why this is not in the session's UI bag: that bag holds
/// everything a session remembers in one entry the server caps, and a review of three hundred files
/// would crowd out the open tabs — read progress is worth more than that, and is not a preference.</para>
///
/// <para>A mark stores the <b>blob sha the file had when it was read</b>, which is what makes a
/// reset per file rather than per pull request: the author pushes again, the files nobody touched
/// keep their sha and stay read, and only the ones that actually moved come back. It is the same
/// thing GitHub keys its own "viewed" on.</para>
/// </summary>
public sealed class PullViewStore
{
    // Pull requests remembered before the oldest is dropped. A repo's review history has no natural
    // end and nothing ever tells us a pull request is finished with, so the file needs a bound.
    private const int MaxPulls = 400;
    // Files remembered per pull request. Past this the pull request is simply large, and the marks
    // that matter are the ones made most recently.
    private const int MaxFiles = 2000;

    private readonly string _file;
    private readonly ILogger<PullViewStore> _log;
    private readonly object _lock = new();
    // Insertion-ordered: the oldest pull request is the first to go when the file is trimmed.
    private Dictionary<string, Dictionary<string, string>> _viewed = new(StringComparer.Ordinal);

    public PullViewStore(ILogger<PullViewStore> log)
    {
        _log = log;
        _file = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "pr-viewed.json");
        Load();
    }

    private static string Key(string repo, int number) => $"{repo}#{number}";

    /// <summary>
    /// The files of this pull request still counted as read: the ones marked, whose sha is the sha
    /// they were marked at. A file whose sha has moved since is left out — that is the reset, and it
    /// costs nothing to compute because the answer is recomputed from the shas on every read.
    /// </summary>
    public IReadOnlyList<string> Viewed(string repo, int number, IReadOnlyDictionary<string, string> shas)
    {
        lock (_lock)
        {
            if (!_viewed.TryGetValue(Key(repo, number), out var marks)) return Array.Empty<string>();
            return marks
                .Where(m => shas.TryGetValue(m.Key, out var sha) && sha == m.Value)
                .Select(m => m.Key)
                .ToList();
        }
    }

    /// <summary>
    /// Mark one file read at the sha it is being read at, or drop the mark. A mark with no sha is
    /// not worth keeping: it could never be reset, so it would claim the file was read for the rest
    /// of the pull request's life however often it changed.
    /// </summary>
    public void Set(string repo, int number, string path, string sha, bool viewed)
    {
        if (string.IsNullOrEmpty(repo) || string.IsNullOrEmpty(path)) return;
        if (viewed && string.IsNullOrEmpty(sha)) return;

        lock (_lock)
        {
            var key = Key(repo, number);
            if (!_viewed.TryGetValue(key, out var marks))
            {
                if (!viewed) return; // nothing to unmark
                _viewed[key] = marks = new(StringComparer.Ordinal);
            }

            if (viewed)
            {
                if (marks.Count >= MaxFiles && !marks.ContainsKey(path))
                    marks.Remove(marks.Keys.First());
                marks[path] = sha;
            }
            else if (!marks.Remove(path)) return; // it was not marked — nothing changed
            // A pull request with nothing left marked is not worth a line in the file.
            if (marks.Count == 0) _viewed.Remove(key);
            else
            {
                // Re-insert last so the most recently read pull request is the last to be trimmed.
                _viewed.Remove(key);
                _viewed[key] = marks;
            }
            Trim();
            Save();
        }
    }

    /// <summary>Drop every mark for one pull request — "unread" for the whole thing.</summary>
    public void Clear(string repo, int number)
    {
        lock (_lock)
        {
            if (!_viewed.Remove(Key(repo, number))) return;
            Save();
        }
    }

    private void Trim()
    {
        while (_viewed.Count > MaxPulls) _viewed.Remove(_viewed.Keys.First());
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var saved = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string>>>(
                File.ReadAllText(_file));
            if (saved is null) return;
            foreach (var (key, marks) in saved.Take(MaxPulls))
                if (!string.IsNullOrEmpty(key) && marks is not null)
                    _viewed[key] = new Dictionary<string, string>(marks.Take(MaxFiles), StringComparer.Ordinal);
        }
        catch (Exception ex)
        {
            // Read progress is worth keeping, but it is not worth failing to start over: carry on
            // with none and let the next mark write a fresh file.
            _log.LogWarning(ex, "Could not load {File}; starting with no viewed marks", _file);
            _viewed = new(StringComparer.Ordinal);
        }
    }

    private void Save()
    {
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(_viewed, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not save viewed marks to {File}", _file);
        }
    }
}
