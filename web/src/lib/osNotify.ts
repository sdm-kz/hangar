/**
 * Raise OS notifications for a batch of sessions that just changed state — the in-page half of the
 * alerting the server does with Web Push, for the case where a tab of the app is actually open.
 *
 * One place for the three things every one of these alerts wants and none of them is interesting
 * for: asking for permission if it hasn't been granted yet (and firing once it is, rather than
 * dropping the first alert of the session on the floor), swallowing the failures — a notification
 * nobody sees must never break the page it was about — and wiring the click to open the session the
 * alert is about.
 */
export interface SessionAlert {
  /** Session the alert is about; clicking the notification opens it. */
  id: string;
  title: string;
  body: string;
  /** Notification tag: a later alert with the same tag replaces the earlier one instead of stacking. */
  tag: string;
}

export function osNotify(alerts: SessionAlert[], open: (id: string) => void) {
  if (alerts.length === 0 || !("Notification" in window)) return;

  const fire = () => {
    for (const alert of alerts) {
      try {
        const n = new Notification(alert.title, { body: alert.body, tag: alert.tag });
        n.onclick = () => {
          window.focus();
          open(alert.id);
          n.close();
        };
      } catch {
        /* ignore — notifications are best-effort */
      }
    }
  };

  if (Notification.permission === "granted") fire();
  else if (Notification.permission !== "denied")
    Notification.requestPermission().then((p) => p === "granted" && fire());
}
