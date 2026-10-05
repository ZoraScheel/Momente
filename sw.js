/* =====================================================================
   gute dinge des tages – Service Worker
   Speichert die App-Dateien auf dem Gerät, damit sie sich auch ohne
   Netz öffnen lässt. Online wird immer zuerst die neueste Version
   geladen; nur wenn das nicht klappt, kommt die gespeicherte.
   Die Daten (GitHub-API) laufen nicht hier durch – darum kümmert
   sich store.js.
   ===================================================================== */

const CACHE = "momente-v1";           // bei größeren Änderungen hochzählen
const FILES = ["./", "./index.html", "./store.js"];
const WAIT_MS = 3000;                 // so lange auf das Netz warten

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.hostname === "api.github.com") return;

  const fromCache = () =>
    caches.match(e.request, { ignoreSearch: true })
      .then((hit) => hit || (e.request.mode === "navigate" ? caches.match("./index.html") : undefined))
      .then((hit) => hit || Response.error());

  const fromNetwork = fetch(e.request).then((res) => {
    const keep = res.ok || res.type === "opaque";   // opaque = Schriftdateien von Google
    if (keep) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  });

  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), WAIT_MS));

  e.respondWith(Promise.race([fromNetwork, timeout]).catch(fromCache));
});
