import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Loader2, X } from "lucide-react";
import { useApi } from "@/lib/node";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Hidden for good once dismissed here: an instance kept to this machine on purpose needs no reminder.
const HIDDEN_KEY = "hangar.passwordNoticeHidden";
const MIN_LENGTH = 8; // the server's own minimum (MinPasswordLength in server/Program.cs)

function hiddenHere(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * A strip under the sidebar's header while no password is set, on the machine itself (the only place
 * such an instance answers), with a dialog that sets one. Until this existed the first password meant
 * writing appsettings.Local.json and restarting the server, which is a lot to ask of someone trying
 * Hangar out, and it is the step that matters before reaching it from a phone. Changing a password that
 * is set is Settings → Security's.
 */
export function PasswordNotice() {
  const api = useApi();
  const [offered, setOffered] = useState(false);
  const [hidden, setHidden] = useState(hiddenHere);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.authConfig().then((cfg) => setOffered(cfg.canSetPassword === true), () => {});
  }, [api]);

  if (!offered || hidden) return null;

  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(HIDDEN_KEY, "1");
    } catch {
      /* hidden for this tab, then */
    }
  };

  return (
    <div role="status" className="shrink-0 border-b bg-sky-500/10 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-px size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p>
            <strong>No password is set.</strong> Hangar answers only this computer until it has one, and
            needs one to be opened from your phone or another machine.
          </p>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setOpen(true)}>
            Set a password…
          </Button>
        </div>
        <button
          type="button"
          title="Don't show this again"
          aria-label="Don't show this again"
          className="text-muted-foreground hover:text-foreground"
          onClick={hide}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {open && <SetPasswordDialog onClose={() => setOpen(false)} onSet={() => setOffered(false)} />}
    </div>
  );
}

/** Set the first password: the strip's "Set a password…", and Settings → Security's. */
export function SetPasswordDialog({ onClose, onSet }: { onClose: () => void; onSet: () => void }) {
  const api = useApi();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = password.length < MIN_LENGTH;
  const mismatch = repeat.length > 0 && repeat !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (tooShort || repeat !== password) return;
    setBusy(true);
    setError(null);
    try {
      await api.setPassword(password);
      onSet();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Set a password</DialogTitle>
            <DialogDescription>
              Anyone who signs in to Hangar has a shell on this computer as you, so make it one you would
              use for your account. This browser stays signed in; other browsers and devices sign in with it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="new-password">Password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">At least {MIN_LENGTH} characters.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="repeat-password">Again</Label>
            <Input
              id="repeat-password"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              aria-invalid={mismatch || undefined}
            />
            {mismatch && <p className="text-xs text-destructive">The two don't match.</p>}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <p className="text-xs text-muted-foreground">To change it later: Settings → Security.</p>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || tooShort || repeat !== password}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Set password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
