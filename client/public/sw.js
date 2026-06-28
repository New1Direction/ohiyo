/* Ohiyo PWA service worker. Push payloads are intentionally content-free. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = typeof payload.title === "string" ? payload.title : "Ohiyo";
  const body = typeof payload.body === "string" ? payload.body : "You have a new message.";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: "ohiyo-content-free",
    renotify: false,
    icon: "/icon.png",
    badge: "/icon.png",
    data: { url: "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        client.navigate?.(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
