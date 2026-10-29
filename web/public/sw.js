// Offline app shell: pages are network-first (fall back to the cached shell), built assets are cache-first.
// API calls are never cached here; the app keeps its own small offline cache and outbox.
const C = "ff-shell-v4";
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(["/", "/manifest.webmanifest"]).catch(() => {}))); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  if (u.pathname.startsWith("/assets/")) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(C).then(x => x.put(e.request, c)); } return r; })));
  } else if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(C).then(x => x.put("/", c)); return r; }).catch(() => caches.match("/")));
  }
});
