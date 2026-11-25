const CACHE_NAME = "impostor-aula-v3";
const ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/assets/bg.png",
  "/assets/icon-192.png",
  "/assets/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET" || url.origin !== self.location.origin ||
      url.pathname.startsWith("/socket.io/") || url.pathname === "/bingo.html") return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)));
        }
        return response;
      }).catch(async () => (await caches.match(req)) || Response.error())
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)));
        }
        return resp;
      });
    })
  );
});
