const CACHE_NAME = "enteral-care-cache-v8";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/service-worker.js",
  "/icon-192.png",
  "/icon-512.png",
  "/badge-96.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      ),
      self.clients.claim()
    ])
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
          return response;
        })
        .catch(() => caches.match("/index.html"));
    })
  );
});

self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: "Powiadomienie",
      body: event.data ? event.data.text() : ""
    };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Powiadomienie o leku", {
      body: data.body || "Czas na lek.",
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      vibrate: [200, 100, 200],
      data: { url: "/", ...data }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});
