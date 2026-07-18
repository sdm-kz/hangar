namespace ClaudeWeb.Server.Auth;

/// <summary>
/// Gates /api/* and /hub/* behind a bearer token (Authorization header or ?access_token= for SignalR).
/// The login endpoint and everything else (the SPA static files) pass through.
/// </summary>
public sealed class TokenAuthMiddleware(RequestDelegate next, TokenStore tokens)
{
    public async Task Invoke(HttpContext ctx)
    {
        var path = ctx.Request.Path;

        var isProtected = path.StartsWithSegments("/api") || path.StartsWithSegments("/hub");
        // The login and auth-config endpoints must be reachable before a token exists. The hook
        // callback (/api/hooks) is called by the claude subprocess, which has no browser token; it
        // authenticates with its own X-Hook-Token header, validated inside the endpoint.
        var isPublic = path.StartsWithSegments("/api/auth/login")
            || path.StartsWithSegments("/api/auth/config")
            // The VAPID public key is not secret and the browser needs it before it can subscribe.
            || path.StartsWithSegments("/api/push/config")
            || path.StartsWithSegments("/api/hooks");

        if (!isProtected || isPublic)
        {
            await next(ctx);
            return;
        }

        // External automation endpoints authenticate with an API key in the X-Api-Key header
        // instead of the browser bearer token. This grants access to /api/external/* only.
        if (path.StartsWithSegments("/api/external"))
        {
            if (!tokens.IsValidApiKey(ctx.Request.Headers["X-Api-Key"].ToString()))
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                await ctx.Response.WriteAsJsonAsync(new { error = "unauthorized" });
                return;
            }
            await next(ctx);
            return;
        }

        var token = ExtractToken(ctx.Request);
        if (!tokens.IsValid(token))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await ctx.Response.WriteAsJsonAsync(new { error = "unauthorized" });
            return;
        }

        await next(ctx);
    }

    private static string? ExtractToken(HttpRequest req)
    {
        var header = req.Headers.Authorization.ToString();
        if (header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            return header["Bearer ".Length..].Trim();

        // SignalR websocket handshake can only pass the token as a query-string parameter.
        var q = req.Query["access_token"].ToString();
        return string.IsNullOrEmpty(q) ? null : q;
    }
}
