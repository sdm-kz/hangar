import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import logo from "@/assets/hangar-logo.png";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      // A 429 (too many attempts) and the 403 of an instance with no password set carry their own
      // explanation; anything else unexpected is just a failed login.
      setError(
        err instanceof ApiError
          ? err.status === 401 ? "Incorrect password" : err.message || "Login failed"
          : "Login failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-8 shadow-sm"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <img src={logo} alt="" className="size-12 object-contain" />
          <h1 className="text-xl font-semibold">Hangar</h1>
          <p className="text-sm text-muted-foreground">Sign in to manage Claude Code sessions</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Shared password"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          Sign in
        </Button>
      </form>
    </div>
  );
}
