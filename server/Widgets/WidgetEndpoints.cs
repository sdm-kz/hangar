using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using Hangar.Server.Auth;
using Hangar.Server.Sessions;

namespace Hangar.Server.Widgets;

/// <summary>Body for the browser's data call: the instance's given params, and how fresh the answer must be.</summary>
public sealed record WidgetDataRequest(Dictionary<string, JsonElement>? Params, string? Mode, string? Instance);

/// <summary>Body for setting secrets from the browser's form: values by name, saved for you or for the session's project.</summary>
public sealed record WidgetSecretsRequest(Dictionary<string, string?>? Values, string? Scope);

/// <summary>Body for what a view reported, relayed by the browser holding it.</summary>
public sealed record WidgetLogRequest(string? Instance, int? Rev, List<WidgetLogItem>? Entries);
public sealed record WidgetLogItem(string? Level, string? Message, int? Line, int? Column);

/// <summary>Body for writing a widget type: its files (a null removes one, on PATCH), and the revision it was read at.</summary>
public sealed record WidgetWriteRequest(Dictionary<string, string?>? Files, int? Rev);

/// <summary>Body for a test run, and for opening an instance.</summary>
public sealed record WidgetTestRequest(Dictionary<string, JsonElement>? Params);
public sealed record WidgetOpenRequest(string? Type, Dictionary<string, JsonElement>? Params, string? Placement);

/// <summary>
/// The widget endpoints (docs/design/widgets.md §9): what the browser uses to list, draw and feed a
/// session's widgets, and the self-service API a session writes them with.
/// </summary>
public static class WidgetEndpoints
{
    public static void Map(WebApplication app)
    {
        // ---- The browser ----------------------------------------------------------------------

        // The types a session can open, with what the + menu and the tabs need to draw them.
        app.MapGet("/api/sessions/{id}/widgets", (string id, SessionManager mgr, WidgetStore store, WidgetSecrets secrets,
            IConfiguration config) =>
        {
            if (Context(mgr, store, id) is not { } ctx) return Results.NotFound();
            return Results.Ok(new
            {
                rev = store.Revision,
                node = NodeStatus(config),
                types = store.VisibleTo(ctx.Folder).Select(x => Summary(x.Type, x.Shadowed, ctx, secrets, config)),
            });
        });

        // A type's view, composed for the frame: the policy and the bridge in front of the view itself.
        app.MapGet("/api/sessions/{id}/widgets/{name}/view", (string id, string name, SessionManager mgr, WidgetStore store) =>
        {
            if (Context(mgr, store, id) is not { } ctx) return Results.NotFound();
            if (store.Resolve(ctx.Folder, name) is not { } type) return Results.NotFound(new { error = $"no widget \"{name}\" here" });
            var files = store.Files(type);
            if (!files.TryGetValue(WidgetManifest.ViewFile, out var view))
                return Results.Ok(new { html = (string?)null, rev = type.Rev, scope = type.Scope, error = "view.html is missing" });
            return Results.Ok(new { html = WidgetGuide.Compose(view), rev = type.Rev, scope = type.Scope, error = (string?)null });
        });

        // An instance's data. "cached" answers at once with whatever there is; "ifStale" (the default)
        // runs the source when the cache is older than the type's refresh; "force" runs it now. The
        // answer carries the params as resolved, the title and the badge, so the client draws a tab
        // without knowing how either is made.
        app.MapPost("/api/sessions/{id}/widgets/{name}/data", async (string id, string name, WidgetDataRequest body,
            SessionManager mgr, WidgetStore store, WidgetRunner runner, WidgetSecrets secrets, WidgetLog log, CancellationToken ct) =>
        {
            if (Context(mgr, store, id) is not { } ctx) return Results.NotFound();
            if (store.Resolve(ctx.Folder, name) is not { } type) return Results.NotFound(new { error = $"no widget \"{name}\" here" });
            if (type.Manifest is not { } m)
                return Results.Ok(new { rev = type.Rev, error = "the widget's files have problems: " + Problems(type.Problems) });

            var (values, errors) = WidgetRunner.ResolveParams(m, body.Params, ctx);
            var title = WidgetRunner.Fill(m.Title, values, ctx);
            if (errors.Count > 0)
                return Results.Ok(new { rev = type.Rev, title, error = string.Join("; ", errors.Select(e => e.Message)), needsParams = true });

            var mode = body.Mode switch { "cached" => WidgetRunner.Mode.Cached, "force" => WidgetRunner.Mode.Force, _ => WidgetRunner.Mode.IfStale };
            var r = await runner.GetAsync(type, values, ctx, mode, ct);
            if (body.Instance is { Length: > 0 } inst && r?.Data is not null) log.Delivered(inst, type.Rev);
            var missing = m.SourceKind == "node" ? secrets.For(type.ProjectId ?? ctx.ProjectId, m.Secrets).Missing : [];
            return Results.Ok(new
            {
                rev = type.Rev,
                title,
                @params = values,
                data = r?.Data,
                fetchedAt = r?.FetchedAt,
                error = r?.Error,
                badge = WidgetRunner.Badge(m, r?.Data),
                missingSecrets = missing,
                durationMs = r?.DurationMs,
            });
        });

        // Secrets from the form Hangar draws (never from the view): saved for you, or for the session's
        // project. Nothing is read back — the answer says only where each name is now set.
        app.MapPost("/api/sessions/{id}/widgets/secrets", (string id, WidgetSecretsRequest body, SessionManager mgr,
            WidgetStore store, WidgetSecrets secrets) =>
        {
            if (Context(mgr, store, id) is not { } ctx) return Results.NotFound();
            var project = body.Scope == WidgetStore.Project ? ctx.ProjectId : null;
            if (body.Scope == WidgetStore.Project && project is null)
                return Results.BadRequest(new { error = "this session's folder is in no project" });
            var values = body.Values ?? new();
            foreach (var (name, value) in values)
                if (!secrets.Set(project, name, value))
                    return Results.BadRequest(new { error = $"could not save {name}: names are A–Z, digits and _, values up to 8 KB" });
            return Results.Ok(new { where = secrets.Where(ctx.ProjectId, values.Keys) });
        });

        // What an instance's view reported, relayed by the browser that holds it.
        app.MapPost("/api/sessions/{id}/widgets/log", (string id, WidgetLogRequest body, SessionManager mgr, WidgetLog log) =>
        {
            if (string.IsNullOrWhiteSpace(body.Instance) || !mgr.HasWidget(id, body.Instance)) return Results.NotFound();
            var entries = (body.Entries ?? []).Take(20).Select(e => new WidgetLogEntry(
                DateTimeOffset.UtcNow,
                e.Level is "warn" or "info" ? e.Level : "error",
                e.Message ?? "",
                e.Line,
                e.Column));
            log.Add(body.Instance, body.Rev, entries);
            return Results.NoContent();
        });

        // ---- The session itself ---------------------------------------------------------------

        // Everything a session needs to write a widget: the guide, the schema it is checked against,
        // the bridge, worked examples, and what this session in particular can do.
        app.MapGet("/api/self/widgets/guide", (HttpContext http, TokenStore tokens, SessionManager mgr, WidgetStore store,
            IConfiguration config, ILoggerFactory lf) =>
        {
            if (Caller(http, tokens, lf, "widgets/guide") is not { } id) return Unauthorized();
            if (Context(mgr, store, id) is not { } ctx) return Results.NotFound();
            var project = store.ProjectFor(ctx.Folder);
            return Results.Ok(new
            {
                contract = WidgetGuide.Contract,
                guide = WidgetGuide.Resource("guide.md"),
                manifestSchema = WidgetManifest.ManifestSchema,
                bridge = WidgetGuide.Resource("bridge.js"),
                examples = WidgetGuide.Examples().Select(e => new { name = e.Name, files = e.Files }),
                environment = Environment(ctx, project, config),
            });
        });

        app.MapGet("/api/self/widgets", (HttpContext http, TokenStore tokens, SessionManager mgr, WidgetStore store,
            WidgetSecrets secrets, IConfiguration config, ILoggerFactory lf) =>
        {
            if (Caller(http, tokens, lf, "widgets") is not { } id) return Unauthorized();
            if (Context(mgr, store, id) is not { } ctx) return Results.NotFound();
            var project = store.ProjectFor(ctx.Folder);
            return Results.Ok(new
            {
                environment = Environment(ctx, project, config),
                types = store.VisibleTo(ctx.Folder).Select(x => Summary(x.Type, x.Shadowed, ctx, secrets, config)),
            });
        });

        app.MapGet("/api/self/widgets/{scope}/{name}", (string scope, string name, HttpContext http, TokenStore tokens,
            SessionManager mgr, WidgetStore store, ILoggerFactory lf) =>
        {
            if (Caller(http, tokens, lf, "widgets/read") is not { } id) return Unauthorized();
            if (Context(mgr, store, id) is not { } ctx) return Results.NotFound();
            var (bad, project) = ScopeOf(scope, ctx);
            if (bad is not null) return bad;
            if (store.Get(scope, project, name) is not { } type) return Results.NotFound(new { error = $"there is no {scope} widget \"{name}\"" });
            return Results.Ok(new
            {
                scope, name = type.Name, rev = type.Rev, updatedAt = type.UpdatedAt, updatedBy = type.UpdatedBy,
                files = store.Files(type),
                problems = type.Problems,
            });
        });

        app.MapPut("/api/self/widgets/{scope}/{name}", (string scope, string name, WidgetWriteRequest body, HttpContext http,
            TokenStore tokens, SessionManager mgr, WidgetStore store, WidgetSecrets secrets, ILoggerFactory lf) =>
            Write(scope, name, body, replace: true, http, tokens, mgr, store, secrets, lf));

        app.MapMethods("/api/self/widgets/{scope}/{name}", ["PATCH"], (string scope, string name, WidgetWriteRequest body,
            HttpContext http, TokenStore tokens, SessionManager mgr, WidgetStore store, WidgetSecrets secrets, ILoggerFactory lf) =>
            Write(scope, name, body, replace: false, http, tokens, mgr, store, secrets, lf));

        app.MapDelete("/api/self/widgets/{scope}/{name}", (string scope, string name, HttpContext http, TokenStore tokens,
            SessionManager mgr, WidgetStore store, ILoggerFactory lf) =>
        {
            if (Caller(http, tokens, lf, "widgets/delete") is not { } id) return Unauthorized();
            if (Context(mgr, store, id) is not { } ctx) return Results.NotFound();
            var (bad, project) = ScopeOf(scope, ctx);
            if (bad is not null) return bad;
            if (!store.Delete(scope, project, name)) return Results.NotFound(new { error = $"there is no {scope} widget \"{name}\"" });
            lf.CreateLogger("SelfApi").LogInformation("Session {Id} deleted {Scope} widget {Name}", id, scope, name);
            return Results.Ok(new { ok = true });
        });

        // A run of the source, straight through, as an instance would make it: the data, or why not.
        app.MapPost("/api/self/widgets/{scope}/{name}/test", async (string scope, string name, WidgetTestRequest body,
            HttpContext http, TokenStore tokens, SessionManager mgr, WidgetStore store, WidgetRunner runner, ILoggerFactory lf,
            CancellationToken ct) =>
        {
            if (Caller(http, tokens, lf, "widgets/test") is not { } id) return Unauthorized();
            if (Context(mgr, store, id) is not { } ctx) return Results.NotFound();
            var (bad, project) = ScopeOf(scope, ctx);
            if (bad is not null) return bad;
            if (store.Get(scope, project, name) is not { } type) return Results.NotFound(new { error = $"there is no {scope} widget \"{name}\"" });
            if (type.Manifest is not { } m)
                return Results.Ok(new { ok = false, error = "the widget's files have problems", problems = type.Problems });
            var (values, errors) = WidgetRunner.ResolveParams(m, body.Params, ctx);
            if (errors.Count > 0) return Results.Ok(new { ok = false, error = "params", problems = errors });
            var r = await runner.TestAsync(type, values, ctx, ct);
            return Results.Ok(new
            {
                ok = r.Error is null,
                data = r.Data,
                error = r.Error,
                stderr = r.Stderr,
                durationMs = r.DurationMs,
                costUsd = r.CostUsd,
                missingSecrets = r.MissingSecrets,
                @params = values,
                badge = WidgetRunner.Badge(m, r.Data),
                title = WidgetRunner.Fill(m.Title, values, ctx),
            });
        });

        // Open an instance in the calling session, the way the + menu's dialog does.
        app.MapPost("/api/self/widget", (WidgetOpenRequest body, HttpContext http, TokenStore tokens, SessionManager mgr,
            WidgetStore store, WidgetSecrets secrets, ILoggerFactory lf) =>
        {
            if (Caller(http, tokens, lf, "widget") is not { } id) return Unauthorized();
            if (Context(mgr, store, id) is not { } ctx) return Results.NotFound();
            if (string.IsNullOrWhiteSpace(body.Type)) return Results.BadRequest(new { error = "no type given" });
            if (store.Resolve(ctx.Folder, body.Type.Trim()) is not { } type)
            {
                var names = store.VisibleTo(ctx.Folder).Where(x => !x.Shadowed).Select(x => x.Type.Name).ToList();
                return Results.NotFound(new
                {
                    error = $"no widget \"{body.Type}\" for this session" + (names.Count > 0 ? $" (there are: {string.Join(", ", names)})" : " (there are none yet)"),
                });
            }
            if (type.Manifest is not { } m)
                return Results.BadRequest(new { error = "the widget's files have problems", problems = type.Problems });
            var placement = string.IsNullOrWhiteSpace(body.Placement) ? m.Placements[0] : body.Placement.Trim();
            if (!m.Placements.Contains(placement))
                return Results.BadRequest(new { error = $"\"{m.Name}\" can be opened as {string.Join(", ", m.Placements)}, not {placement}" });

            var given = (body.Params ?? new()).Where(kv => kv.Value.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined))
                .ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);
            var (values, errors) = WidgetRunner.ResolveParams(m, given, ctx);
            if (errors.Count > 0) return Results.BadRequest(new { error = string.Join("; ", errors.Select(e => e.Message)) });

            if (mgr.OpenWidget(id, m.Name, given, placement) is not { } instance) return Results.NotFound();
            return Results.Ok(new
            {
                id = instance,
                type = m.Name,
                scope = type.Scope,
                placement,
                @params = values,
                linked = m.Params.Where(p => !given.ContainsKey(p.Name) && p.From.Count > 0).Select(p => p.Name),
                title = WidgetRunner.Fill(m.Title, values, ctx),
                missingSecrets = m.SourceKind == "node" ? secrets.For(type.ProjectId ?? ctx.ProjectId, m.Secrets).Missing : [],
            });
        });

        // What an instance's view has reported: errors and warnings, and whether it was ever handed data.
        app.MapGet("/api/self/widgets/instances/{instance}/log", (string instance, HttpContext http, TokenStore tokens,
            SessionManager mgr, WidgetLog log, ILoggerFactory lf) =>
        {
            if (Caller(http, tokens, lf, "widgets/log") is not { } id) return Unauthorized();
            if (!mgr.HasWidget(id, instance)) return Results.NotFound(new { error = "this session has no such widget instance" });
            var got = log.Get(instance);
            return Results.Ok(new
            {
                id = instance,
                entries = got?.Entries ?? [],
                deliveredAt = got?.LastData,
                rev = got?.Rev,
                note = got is null ? "no browser has shown this instance yet, so its view has not run" : null,
            });
        });
    }

    // ---- Helpers ------------------------------------------------------------------------------

    private static IResult Write(string scope, string name, WidgetWriteRequest body, bool replace, HttpContext http,
        TokenStore tokens, SessionManager mgr, WidgetStore store, WidgetSecrets secrets, ILoggerFactory lf)
    {
        if (Caller(http, tokens, lf, "widgets/write") is not { } id) return Unauthorized();
        if (Context(mgr, store, id) is not { } ctx) return Results.NotFound();
        var (bad, project) = ScopeOf(scope, ctx);
        if (bad is not null) return bad;
        if (body.Files is not { Count: > 0 } files) return Results.BadRequest(new { error = "no files given" });

        // On PUT the set is the whole widget, so a null there is just a file that isn't in it.
        var set = replace ? files.Where(kv => kv.Value is not null).ToDictionary(kv => kv.Key, kv => kv.Value) : files;
        var r = store.Write(scope, project, name, set, replace, body.Rev, ctx.Session);
        if (r.ConflictRev is { } current)
            return Results.Json(new { ok = false, rev = current, errors = r.Errors, warnings = r.Warnings }, statusCode: StatusCodes.Status409Conflict);
        if (r.NotFound) return Results.NotFound(new { ok = false, errors = r.Errors });
        if (!r.Ok)
            return Results.Json(new { ok = false, errors = r.Errors, warnings = r.Warnings }, statusCode: StatusCodes.Status422UnprocessableEntity);

        var m = r.Type!.Manifest!;
        lf.CreateLogger("SelfApi").LogInformation("Session {Id} ('{Name}') wrote {Scope} widget {Widget} at rev {Rev}",
            id, ctx.Session, scope, name, r.Type.Rev);
        return Results.Ok(new
        {
            ok = true,
            scope,
            name,
            rev = r.Type.Rev,
            warnings = r.Warnings,
            missingSecrets = m.SourceKind == "node" ? secrets.For(project ?? ctx.ProjectId, m.Secrets).Missing : [],
            open = $"/hgr-open-tab {name}",
        });
    }

    private static (IResult? Error, string? ProjectId) ScopeOf(string scope, WidgetContext ctx) => scope switch
    {
        WidgetStore.Personal => (null, null),
        WidgetStore.Project when ctx.ProjectId is { } p => (null, p),
        WidgetStore.Project => (Results.Json(new { error = "this session's folder is in no project; write it as personal, or add the folder to a project" },
            statusCode: StatusCodes.Status409Conflict), null),
        "repo" => (Results.BadRequest(new { error = "repo-scope widgets are not available yet; use project or personal" }), null),
        _ => (Results.BadRequest(new { error = $"scope is \"personal\" or \"project\", not \"{scope}\"" }), null),
    };

    private static object Environment(WidgetContext ctx, Hangar.Contract.Project? project, IConfiguration config) => new
    {
        node = NodeStatus(config),
        claude = "available",
        scopes = project is null ? new[] { WidgetStore.Personal } : [WidgetStore.Personal, WidgetStore.Project],
        defaultScope = project is null ? WidgetStore.Personal : WidgetStore.Project,
        project = project is null ? null : new { id = project.Id, name = project.Name },
        session = ctx.Session,
        branch = ctx.Branch,
        folder = ctx.Folder,
    };

    private static object NodeStatus(IConfiguration config)
    {
        var n = NodeRuntime.Find(config);
        return new { available = n.Error is null, version = n.Version, error = n.Error };
    }

    /// <summary>A type as the + menu, the tabs and a listing session see it.</summary>
    private static object Summary(WidgetType t, bool shadowed, WidgetContext ctx, WidgetSecrets secrets, IConfiguration config)
    {
        var m = t.Manifest;
        var node = m?.SourceKind == "node" ? NodeRuntime.Find(config) : null;
        var where = m is null ? new() : secrets.Where(t.ProjectId ?? ctx.ProjectId, m.SourceKind == "node" ? m.Secrets : []);
        return new
        {
            scope = t.Scope,
            name = t.Name,
            rev = t.Rev,
            updatedAt = t.UpdatedAt,
            updatedBy = t.UpdatedBy,
            shadowed,
            title = m?.Title ?? t.Name,
            description = m?.Description,
            icon = m?.Icon,
            placements = m?.Placements ?? [],
            badge = m?.Badge,
            popover = m is null ? null : new { width = m.PopoverWidth, height = m.PopoverHeight },
            source = m?.SourceKind,
            refreshSeconds = m?.Refresh?.TotalSeconds,
            @params = m?.Params.Select(p => new
            {
                name = p.Name, type = p.Type, label = p.Label, required = p.Required, from = p.From, pattern = p.Pattern,
                @default = p.Default,
                options = p.Schema.TryGetProperty("enum", out var e) ? e : (JsonElement?)null,
            }) ?? [],
            secrets = where,
            missingSecrets = where.Where(kv => kv.Value is null).Select(kv => kv.Key),
            runnable = m is not null && node?.Error is null,
            problem = m is null ? Problems(t.Problems) : node?.Error,
        };
    }

    private static string Problems(IEnumerable<WidgetIssue> issues) =>
        string.Join("; ", issues.Select(i => $"{(i.File.Length > 0 ? i.File + (i.Path is { } p ? p : "") + ": " : "")}{i.Message}"));

    private static IResult Unauthorized() =>
        Results.Json(new { error = "unauthorized" }, statusCode: StatusCodes.Status401Unauthorized);

    // The same check as Program's SelfCaller, for the endpoints that live here: the session id it was
    // launched with, once the hook token it was launched with checks out.
    private static string? Caller(HttpContext ctx, TokenStore tokens, ILoggerFactory lf, string what)
    {
        var id = ctx.Request.Headers["X-Session-Id"].ToString();
        if (id.Length > 0 && tokens.IsValidHookToken(ctx.Request.Headers["X-Hook-Token"].ToString()))
            return id;
        lf.CreateLogger("SelfApi").LogWarning(
            "Self-{What} rejected: stale or missing X-Hook-Token/X-Session-Id from session {Id}", what, id);
        return null;
    }

    /// <summary>The session a widget is open in, as its params are read from it; null when there is no such session.</summary>
    private static WidgetContext? Context(SessionManager mgr, WidgetStore store, string id)
    {
        if (mgr.GetAny(id) is not { } s) return null;
        // The header's branch is the picked worktree's when there is one (POST /api/self/worktree).
        var tree = mgr.GetUi(id)?.State.TryGetValue("gitWorktree", out var w) == true && w.ValueKind == JsonValueKind.String
            ? w.GetString()
            : null;
        var branch = Branch(string.IsNullOrEmpty(tree) ? s.WorkingDirectory : tree);
        return new WidgetContext(s.Name, branch, s.WorkingDirectory, store.ProjectFor(s.WorkingDirectory)?.Id);
    }

    private static readonly ConcurrentDictionary<string, (string? Branch, DateTime At)> Branches = new(StringComparer.OrdinalIgnoreCase);

    // The branch alone, which is all a param needs — a full status lists every changed file, and this is
    // asked on every fetch. Held for a few seconds, since a page of widgets asks all at once.
    private static string? Branch(string folder)
    {
        if (Branches.TryGetValue(folder, out var c) && DateTime.UtcNow - c.At < TimeSpan.FromSeconds(5)) return c.Branch;
        string? branch = null;
        try
        {
            var psi = new ProcessStartInfo("git") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
            psi.ArgumentList.Add("-C"); psi.ArgumentList.Add(folder);
            psi.ArgumentList.Add("rev-parse"); psi.ArgumentList.Add("--abbrev-ref"); psi.ArgumentList.Add("HEAD");
            using var p = Process.Start(psi)!;
            // Waited on before reading, so the timeout holds: a branch name is far less than a pipe holds.
            if (!p.WaitForExit(3000))
            {
                try { p.Kill(entireProcessTree: true); } catch { /* gone */ }
            }
            else
            {
                var output = p.StandardOutput.ReadToEnd().Trim();
                if (p.ExitCode == 0 && output.Length > 0 && output != "HEAD") branch = output;
            }
        }
        catch (Exception) { /* no git, or not a repo: no branch to read */ }
        Branches[folder] = (branch, DateTime.UtcNow);
        return branch;
    }
}
