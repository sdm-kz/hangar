import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Bell, BellOff, BellRing } from "lucide-react";
import {
  disablePush,
  enablePush,
  getPushState,
  isPushSupported,
  syncSubscription,
  type PushState,
} from "@/lib/push";

/**
 * Toggle for background push notifications. Sits next to the theme toggle in the sidebar footer.
 * Renders by state: hidden where unsupported, an install hint on iOS-in-tab, an enable bell when
 * available, and an active bell (click to disable) once subscribed. The enable click is the required
 * user gesture for iOS.
 */
export function NotificationToggle() {
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

  if (state === null || state === "unsupported") return null;

  async function onClick() {
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

  const { icon, title, disabled } = render(state);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground"
      title={title}
      disabled={disabled || busy}
      onClick={onClick}
    >
      {icon}
    </Button>
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
