// Minimal service worker: Web Push only. Deliberately no offline/precaching — this is a live
// terminal app, and a cached SPA shell would serve stale JS. We only handle `push` (show the OS
// notification the server sent) and `notificationclick` (focus the app on the right session).

self.addEventListener("install", () => {
  // Take over as the active SW as soon as it's installed, so pushes work without a second reload.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Hangar", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Hangar";
  const options = {
    body: data.body || "",
    tag: data.tag,
    // Replace an existing notification with the same tag rather than stacking a duplicate.
    renotify: !!data.tag,
    // `node` is set only on an alert this node relayed for a peer's session (plans/multi-node.md §5).
    data: { sessionId: data.sessionId || null, node: data.node || null },
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png", // Android draws it from the alpha alone: a white silhouette
  };

  // Always shown, even with an app window open on this device: a page that has a push subscription
  // raises no notification of its own (osNotify), so this is the only one. Skipping it is not an option
  // on iOS anyway — a push that shows nothing gets Safari's own "updated in the background" notice in
  // its place, which is how an open app on the iPhone used to get two of everything.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  const nodeId = event.notification.data && event.notification.data.node;

  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open window if there is one; otherwise open the app.
      const client = wins[0];
      if (client) {
        await client.focus();
        if (sessionId) client.postMessage({ type: "open-session", sessionId, node: nodeId || null });
        return;
      }
      // No window open: launch to a URL carrying the session so the SPA can select it on boot.
      const url = !sessionId
        ? "/"
        : nodeId
          ? `/?node=${encodeURIComponent(nodeId)}&session=${encodeURIComponent(sessionId)}`
          : `/?session=${encodeURIComponent(sessionId)}`;
      await self.clients.openWindow(url);
    })()
  );
});
