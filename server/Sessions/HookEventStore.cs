using System.Collections.Concurrent;
using System.Text.Json;

namespace ClaudeWeb.Server.Sessions;

/// <summary>Authoritative, hook-derived view of one session: what Claude is doing right now.</summary>
public sealed record HookStatus(bool Busy, bool Waiting, string? CurrentTool, DateTimeOffset LastEventAt);

/// <summary>
/// Collects Claude Code hook callbacks (delivered to <c>POST /api/hooks</c>) and turns them into a
/// per-session live status — busy (generating), waiting (on a permission/idle prompt), and the tool
/// currently running. Keyed by <em>our</em> session GUID (the hook posts it back via the
/// <c>X-Session-Id</c> header, sourced from the <c>CLAUDEWEB_SESSION_ID</c> env var we inject at
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
                status = new HookStatus(s.Busy, s.Waiting, s.CurrentTool, s.LastEventAt);
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
    /// body; we read <c>hook_event_name</c> and, where relevant, <c>tool_name</c> /
    /// <c>notification_type</c>. Unknown events just refresh the timestamp.
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
                    break;
                case "UserPromptSubmit":
                case "UserPromptExpansion":
                    s.Busy = true; s.Waiting = false; s.CurrentTool = null;
                    break;
                case "PreToolUse":
                    s.Busy = true; s.Waiting = false; s.CurrentTool = tool;
                    break;
                case "PostToolUse":
                case "PostToolUseFailure":
                case "PostToolBatch":
                    s.Busy = true; s.CurrentTool = null;
                    break;
                case "SubagentStart":
                    s.Busy = true; s.Waiting = false;
                    break;
                case "PermissionRequest":
                    // Paused on a permission dialog: not generating, waiting on the user.
                    s.Busy = false; s.Waiting = true;
                    break;
                case "PermissionDenied":
                    s.Waiting = false;
                    break;
                case "Notification":
                    // Map the notification type to a waiting transition: a genuine "needs you" prompt
                    // sets waiting; a completion/auth notification clears it; anything unrecognized is
                    // left untouched (a later Stop/tool event will reconcile the status).
                    switch (WaitingNotification(notif))
                    {
                        case true: s.Busy = false; s.Waiting = true; break;
                        case false: s.Waiting = false; break;
                        // null: unknown/untyped — no status change
                    }
                    break;
                case "Stop":
                case "StopFailure":
                case "SessionEnd":
                    s.Busy = false; s.Waiting = false; s.CurrentTool = null;
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
