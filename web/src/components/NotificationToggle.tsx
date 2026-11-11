import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Bell, BellOff, BellRing, Loader2 } from "lucide-react";
import {
  disablePush,
  enablePush,
  getPushState,
  isPushSupported,
  syncSubscription,
  type PushState,
} from "@/lib/push";

/**
 * This browser's push subscription and a way to flip it: what the footer's bell and Settings →
 * Notifications both draw. The flip is the click's own work, which iOS needs as the user gesture.
 */
function usePush() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isPushSupported()) {
      setState("unsupported");
      return;
    }
    getPushState().then((s) => {
      setState(s);
      // Re-register a possibly-rotated endpoint with the server when already on.
      if (s === "subscribed") syncSubscription();
    });
  }, []);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      if (state === "subscribed") setState(await disablePush());
      else if (state === "default") setState(await enablePush());
      // "needs-install" / "denied": nothing to do on click; the title explains why.
    } catch {
      setState(await getPushState());
    } finally {
      setBusy(false);
    }
  }

  return { state, busy, toggle };
}

/**
 * Toggle for background push notifications. Sits next to the theme toggle in the sidebar footer.
 * Renders by state: hidden where unsupported, an install hint on iOS-in-tab, an enable bell when
 * available, and an active bell (click to disable) once subscribed. The enable click is the required
 * user gesture for iOS.
 */
export function NotificationToggle() {
  const { state, busy, toggle } = usePush();

  if (state === null || state === "unsupported") return null;

  const { icon, title, disabled } = render(state);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground"
      title={title}
      disabled={disabled || busy}
      onClick={toggle}
    >
      {icon}
    </Button>
  );
}

/**
 * Settings → Notifications: the bell's state said in words, and the same switch as a button. It reads
 * the state for itself, as the bell does; the bell asks again when Settings closes (see AppSidebar).
 */
export function NotificationsPanel() {
  const { state, busy, toggle } = usePush();

  if (state === null) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;

  if (state === "unsupported")
    return (
      <p className="text-sm text-muted-foreground" data-setting="notifications.push">
        This browser can't receive push notifications.
      </p>
    );

  const { icon, title, disabled } = render(state);
  return (
    <section className="flex flex-col gap-2" data-setting="notifications.push">
      <h3 className="text-sm font-medium">Push notifications</h3>
      <p className="text-xs text-muted-foreground">
        An alert on this device when a session starts waiting on you or ends a turn on an error, with every
        tab closed or the phone locked. Each browser and device is switched on by itself.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-sm">
          {icon}
          {state === "subscribed" ? "On in this browser" : disabled ? title : "Off in this browser"}
        </span>
        {!disabled && (
          <Button size="sm" variant="outline" disabled={busy} onClick={toggle}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {state === "subscribed" ? "Turn off" : "Turn on"}
          </Button>
        )}
      </div>
    </section>
  );
}

function render(state: PushState): { icon: React.ReactNode; title: string; disabled: boolean } {
  switch (state) {
    case "subscribed":
      return {
        icon: <BellRing className="size-4 text-foreground" />,
        title: "Notifications on — click to turn off",
        disabled: false,
      };
    case "needs-install":
      return {
        icon: <BellOff className="size-4" />,
        title: "Add this app to your Home Screen (Share → Add to Home Screen) to enable notifications",
        disabled: true,
      };
    case "denied":
      return {
        icon: <BellOff className="size-4" />,
        title: "Notifications are blocked — enable them for this site in your browser settings",
        disabled: true,
      };
    default:
      return {
        icon: <Bell className="size-4" />,
        title: "Enable background notifications",
        disabled: false,
      };
  }
}
