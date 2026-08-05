import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, getToken, setToken } from "@/lib/api";
import { Login } from "@/components/Login";
import { ServerFileViewer } from "@/components/ServerFileViewer";

type AuthStatus = "loading" | "authed" | "anon";

/**
 * Standalone full-page file preview, mounted by main.tsx when the URL carries `?preview=<abs path>`
 * (see previewUrl). Renders just the viewer — no sidebar, no session stream/polling — so it's cheap
 * to keep open in its own browser tab, and the path in the query string survives a refresh. Auth
 * mirrors App's bootstrap: the token is shared via localStorage, so a tab opened from a logged-in
 * app is already authenticated; otherwise the login screen appears first.
 */
export function PreviewApp({ path }: { path: string }) {
  const [auth, setAuth] = useState<AuthStatus>("loading");

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.authConfig();
        if (!cfg.authRequired) {
          setToken("dev"); // any token passes when auth is disabled
          setAuth("authed");
        } else {
          setAuth(getToken() ? "authed" : "anon");
        }
      } catch {
        setAuth(getToken() ? "authed" : "anon");
      }
    })();
  }, []);

  // Name the browser tab after the file so preview tabs are tellable apart.
  useEffect(() => {
    const name = path.split(/[/\\]+/).filter(Boolean).pop() ?? path;
    document.title = `${name} - Claude Web`;
  }, [path]);

  if (auth === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (auth === "anon") {
    return <Login onSuccess={() => setAuth("authed")} />;
  }

  return <ServerFileViewer path={path} />;
}
