using System.Collections.Concurrent;
using System.Text.Json;

namespace Hangar.Server.Sessions;

/// <summary>Authoritative, hook-derived view of one session: what Claude is doing right now.</summary>
public sealed record HookStatus(
    bool Busy,
    bool Waiting,
    string? CurrentTool,
    DateTimeOffset LastEventAt,
    /// <summary>
    /// What Claude is blocked on, in words — "Wants to run Bash: git push origin main", or whatever
    /// the notification said. Null unless <paramref name="Waiting"/>; a dot can only say that someone
    /// is blocked, and the thing you actually want to know from the next room is on what.
    /// </summary>
    string? WaitingOn,
    /// <summary>
    /// Why the last turn ended badly, as Claude's <c>StopFailure</c> hook names it ("rate_limit"), or
    /// null when it ended normally. A turn that died on a rate limit and one that finished both stop
    /// emitting, so without this the two are the same silence.
    /// </summary>
    string? Failure,
    /// <summary>The failed turn's last assistant message, where there was one — the human sentence behind
    /// <paramref name="Failure"/>'s machine name.</summary>
    string? FailureMessage);

/// <summary>
/// Collects Claude Code hook callbacks (delivered to <c>POST /api/hooks</c>) and turns them into a
/// per-session live status — busy (generating), waiting (on a permission/idle prompt), and the tool
/// currently running. Keyed by <em>our</em> session GUID (the hook posts it back via the
/// <c>X-Session-Id</c> header, sourced from the <c>HANGAR_SESSION_ID</c> env var we inject at
/// launch). This replaces the fragile terminal-scraping heuristics with exact lifecycle transitions;
/// <see cref="SessionManager"/> consults it first and falls back to the heuristics only for sessions
/// that haven't produced a hook event yet.
/// </summary>
public sealed class HookEventStore
{
    // One mutable state cell per session, mutated under its own lock. Hooks for a single session fire
    // sequentially, but different sessions can post concurrently — hence the concurrent dictionary.
    private sealed class State
    {
        public bool Busy;
        public bool Waiting;
        public string? CurrentTool;
        public string? WaitingOn;
        public string? Failure;
        public string? FailureMessage;
        public DateTimeOffset LastEventAt;
        public string? ClaudeSessionId; // Claude Code's own session id (for --resume of the exact convo)
        public readonly Queue<string> Recent = new(); // last few "event[:tool]" strings, for debug/logging
        public readonly object Gate = new();
    }

    private const int RecentCapacity = 50;

    private readonly ConcurrentDictionary<string, State> _byId = new();
    private readonly ILogger<HookEventStore> _log;

    public HookEventStore(ILogger<HookEventStore> log) => _log = log;

    /// <summary>Raised after any ingested event changes a session's status, so the hub can push immediately.</summary>
    public event Action? Changed;

    /// <summary>
    /// Raised the first time (and on any change) we learn Claude's own session id for one of our
    /// sessions: <c>(ourSessionId, claudeSessionId)</c>. Lets <see cref="SessionManager"/> stamp the id
    /// where it's needed for an exact <c>--resume</c> later — the persisted state file and the matching
    /// "recent" launch preset — at the moment it becomes known rather than on the next incidental save.
    /// </summary>
    public event Action<string, string>? ClaudeSessionIdCaptured;

    /// <summary>Current hook-derived status for a session, or false if it hasn't produced an event yet.</summary>
    public bool TryGetStatus(string sessionId, out HookStatus status)
    {
        if (_byId.TryGetValue(sessionId, out var s))
        {
            lock (s.Gate)
                status = new HookStatus(
                    s.Busy, s.Waiting, s.CurrentTool, s.LastEventAt, s.WaitingOn, s.Failure, s.FailureMessage);
            return true;
        }
        status = default!;
        return false;
    }

    /// <summary>Drop a session's hook state (on session removal).</summary>
    public void Forget(string sessionId) => _byId.TryRemove(sessionId, out _);

    /// <summary>
    /// Claude Code's own session id for our session, once a hook has reported it — used to reopen the
    /// exact conversation with <c>--resume</c> (a folder can hold several sessions, so <c>--continue</c>
    /// picks the wrong one). Null until the first hook arrives.
    /// </summary>
    public string? ClaudeSessionId(string sessionId)
    {
        if (_byId.TryGetValue(sessionId, out var s))
            lock (s.Gate) return s.ClaudeSessionId;
        return null;
    }

    /// <summary>
    /// Apply one hook callback to a session's status. <paramref name="payload"/> is the raw hook JSON
    /// body; we read <c>hook_event_name</c> and, where relevant, <c>tool_name</c> / <c>tool_input</c> /
    /// <c>notification_type</c> / <c>message</c> / <c>error</c>. Unknown events just refresh the timestamp.
    /// </summary>
    public void Ingest(string sessionId, JsonElement payload)
    {
        var evt = Str(payload, "hook_event_name") ?? Str(payload, "hookEventName");
        if (string.IsNullOrEmpty(evt)) return;
        var tool = Str(payload, "tool_name") ?? Str(payload, "toolName");
        var notif = Str(payload, "notification_type") ?? Str(payload, "notificationType");
        var claudeSessionId = Str(payload, "session_id") ?? Str(payload, "sessionId");

        var s = _byId.GetOrAdd(sessionId, _ => new State());
        var newClaudeSessionId = false;
        lock (s.Gate)
        {
            s.LastEventAt = DateTimeOffset.Now;
            if (!string.IsNullOrEmpty(claudeSessionId) && s.ClaudeSessionId != claudeSessionId)
            {
                s.ClaudeSessionId = claudeSessionId;
                newClaudeSessionId = true;
            }
            switch (evt)
            {
                case "SessionStart":
                    s.Busy = false; s.Waiting = false; s.CurrentTool = null;
                    Unblock(s); ClearFailure(s);
                    break;
                case "UserPromptSubmit":
                case "UserPromptExpansion":
                    s.Busy = true; s.Waiting = false; s.CurrentTool = null;
                    Unblock(s); ClearFailure(s);
                    break;
                case "PreToolUse":
                    s.Busy = true; s.Waiting = false; s.CurrentTool = tool;
                    Unblock(s); ClearFailure(s);
                    break;
                case "PostToolUse":
                case "PostToolUseFailure":
                case "PostToolBatch":
                    // A tool that ran is also the answer to the permission dialog that was asking about
                    // it: approving one is the one path out of Waiting that fires no event of its own.
                    s.Busy = true; s.Waiting = false; s.CurrentTool = null;
                    Unblock(s);
                    break;
                case "SubagentStart":
                    s.Busy = true; s.Waiting = false;
                    Unblock(s);
                    break;
                case "PermissionRequest":
                    // Paused on a permission dialog: not generating, waiting on the user — and, unlike
                    // every other waiting state, able to say exactly what it is asking to do.
                    s.Busy = false; s.Waiting = true;
                    s.WaitingOn = PermissionSummary(tool, payload);
                    break;
                case "PermissionDenied":
                    s.Waiting = false;
                    Unblock(s);
                    break;
                case "Notification":
                    // Map the notification type to a waiting transition: a genuine "needs you" prompt
                    // sets waiting; a completion/auth notification clears it; anything unrecognized is
                    // left untouched (a later Stop/tool event will reconcile the status).
                    switch (WaitingNotification(notif))
                    {
                        case true:
                            s.Busy = false; s.Waiting = true;
                            // Claude writes this line for a human to read ("Claude needs your permission
                            // to use Bash"), so prefer it to anything we could phrase ourselves — but
                            // keep a permission summary we already have, which names the command.
                            s.WaitingOn = s.WaitingOn ?? Truncate(Str(payload, "message"), DetailLimit);
                            break;
                        case false: s.Waiting = false; Unblock(s); break;
                        // null: unknown/untyped — no status change
                    }
                    break;
                case "StopFailure":
                    // The turn ended on an API error rather than an answer. Same stop as below, plus the
                    // reason — the one thing that distinguishes it from a job well done.
                    s.Busy = false; s.Waiting = false; s.CurrentTool = null;
                    Unblock(s);
                    // Two spellings in the wild: the docs match this hook on `error_type`
                    // (rate_limit, overloaded, server_error, …), while shipped integrations read
                    // `error`. Take either, and still record the failure when neither is there —
                    // that the turn ended badly is the part worth showing.
                    s.Failure = Str(payload, "error_type") ?? Str(payload, "error") ?? "error";
                    s.FailureMessage = Truncate(Str(payload, "last_assistant_message"), DetailLimit);
                    break;
                case "Stop":
                case "SessionEnd":
                    s.Busy = false; s.Waiting = false; s.CurrentTool = null;
                    Unblock(s); ClearFailure(s);
                    break;
                // SubagentStop, PreCompact, etc.: no status change, just the timestamp refresh above.
            }

            s.Recent.Enqueue(tool is null ? evt : $"{evt}:{tool}");
            while (s.Recent.Count > RecentCapacity) s.Recent.Dequeue();
        }

        _log.LogTrace("Hook {Event} for session {Id} (tool={Tool}, notif={Notif})", evt, sessionId, tool, notif);
        if (newClaudeSessionId) ClaudeSessionIdCaptured?.Invoke(sessionId, claudeSessionId!);
        Changed?.Invoke();
    }

    /// <summary>
    /// End a turn that was interrupted with Esc, which no hook reports: <c>Stop</c> doesn't run on a
    /// user interrupt, so the session would read as working until its next prompt. The caller has seen
    /// the interruption on screen; <paramref name="seenAfter"/> is the event time it read the status at,
    /// and a hook that has landed since is newer than that screen, so it wins and nothing changes.
    /// </summary>
    public bool EndInterruptedTurn(string sessionId, DateTimeOffset seenAfter)
    {
        if (!_byId.TryGetValue(sessionId, out var s)) return false;
        lock (s.Gate)
        {
            if (s.LastEventAt != seenAfter || (!s.Busy && !s.Waiting)) return false;
            s.Busy = false; s.Waiting = false; s.CurrentTool = null;
            Unblock(s);
            s.Recent.Enqueue("Interrupted");
            while (s.Recent.Count > RecentCapacity) s.Recent.Dequeue();
        }
        _log.LogDebug("Session {Id}: turn interrupted on screen, no longer busy", sessionId);
        Changed?.Invoke();
        return true;
    }

    // Longest detail we keep. These are read in a sidebar tooltip and a phone's notification body,
    // both of which cut off long before this — the limit is here so a pasted essay of a permission
    // argument can't ride the snapshot to every connected client once a second.
    private const int DetailLimit = 160;

    // Leaving the waiting state drops what it was waiting on with it: a stale "Wants to run Bash: rm -rf
    // build" outliving its dialog reads as a live question, and there is no event that retracts one.
    private static void Unblock(State s) => s.WaitingOn = null;

    // A new turn supersedes the last one's failure. Nothing retracts a StopFailure either, so without
    // this the rate limit you already retried past stays on the row until the session is closed.
    private static void ClearFailure(State s)
    {
        s.Failure = null;
        s.FailureMessage = null;
    }

    /// <summary>
    /// What a permission dialog is asking for, as a line to show: the tool, plus the part of its input
    /// worth reading — the command for <c>Bash</c>, the path for an edit. Everything else is a shape we
    /// can't summarise usefully, so it gets the tool name alone rather than a JSON blob.
    /// </summary>
    private static string? PermissionSummary(string? tool, JsonElement payload)
    {
        if (string.IsNullOrEmpty(tool)) return null;
        var input = payload.ValueKind == JsonValueKind.Object
                    && payload.TryGetProperty("tool_input", out var v)
                    && v.ValueKind == JsonValueKind.Object
            ? v
            : default;
        var preview = Truncate(Str(input, "command") ?? Str(input, "file_path"), DetailLimit);
        return preview is null ? $"Wants to run {tool}" : $"Wants to run {tool}: {preview}";
    }

    // Trim to one readable line: collapse the newlines a heredoc'd command is full of, then cut.
    private static string? Truncate(string? text, int max)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var flat = string.Join(" ", text.Split('\n', '\r', StringSplitOptions.RemoveEmptyEntries
            | StringSplitOptions.TrimEntries));
        return flat.Length <= max ? flat : flat[..(max - 1)] + "…";
    }

    // Whether a Notification of this type means Claude is *blocked* needing the user. Types are the
    // documented Notification matcher values (docs.claude.com/en/hooks#notification):
    //   true  → Claude is blocked and needs you now: a permission approval, an MCP elicitation dialog,
    //           or an agent-team teammate needing input → set waiting.
    //   false → nothing to answer → clear any waiting. This deliberately includes `idle_prompt`
    //           ("Claude is done and waiting for your next prompt"): it fires ~60s after EVERY finished
    //           turn, so treating it as "waiting" lit up every idle session. We treat it as plain idle.
    //   null  → unrecognized or untyped → leave status unchanged rather than risk a false "waiting".
    private static bool? WaitingNotification(string? type) => type switch
    {
        "permission_prompt" or "elicitation_dialog" or "agent_needs_input" => true,
        "idle_prompt" or "auth_success" or "agent_completed" or "elicitation_complete" or "elicitation_response" => false,
        _ => null,
    };

    // Read a string property, tolerating non-string/missing values (returns null).
    private static string? Str(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object
        && obj.TryGetProperty(name, out var v)
        && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;
}
