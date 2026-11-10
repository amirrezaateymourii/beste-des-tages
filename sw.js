// Service worker: install support, faster loading, and reminders.

const CACHE = "bdt-v5"; // bump when you change the list below
const SHELL = [
  "./", "./index.html", "./app.js", "./photo.js", "./push.js",
  "./config.js", "./styles.css", "./manifest.webmanifest",
  "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/badge-96.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Network first for our own files (so updates arrive), cache as fallback.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match("./index.html"))),
  );
});

// ------------------------------------------------------------ reminders
// The server sends one every hour after your chosen time until you write.
// Same tag = it replaces the last one instead of piling up; renotify = the
// phone alerts again; requireInteraction = on Android and desktop it stays
// on screen until tapped. The icon badge stays until the app clears it.

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data?.json() ?? {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || "Best of the Day", {
      body: d.body || "What was the best part of your day?",
      tag: d.tag || "daily-reminder",
      renotify: true,
      requireInteraction: true,
      icon: "icons/icon-192.png",
      badge: "icons/badge-96.png",
      data: { url: "./" },
    });
    if (self.navigator.setAppBadge) await self.navigator.setAppBadge(d.waiting || 1).catch(() => {});
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (open) return open.focus();
    return self.clients.openWindow(e.notification.data?.url || "./");
  })());
});
