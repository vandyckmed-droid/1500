/* v2: instant opens.
   - rankings.json: stale-while-revalidate — cached copy paints immediately,
     the network copy replaces it in the background for the next read. Explicit
     refreshes (request.cache === "no-store", used by pull-to-refresh and the
     foreground refetch) skip the cache and hit the network directly.
   - navigations/shell: network-first with a 3.5s timeout falling back to
     cache, so merges show up promptly but a bad connection still opens.
   - other same-origin assets (icons, manifest): cache-first with background
     revalidate. */
const CACHE = "sp1500-v2";

self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

const put = (req, resp) => {
  if (resp && resp.ok) {
    const copy = resp.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
  }
  return resp;
};
const fresh = req => fetch(req, {cache: "no-store"}).then(r => put(req, r));

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  if (url.pathname.endsWith("/data/rankings.json")) {
    if (e.request.cache === "no-store") {
      e.respondWith(fresh(e.request).catch(() => caches.match(e.request)));
    } else {
      e.respondWith(caches.match(e.request).then(hit => {
        const update = fresh(e.request).catch(() => hit);
        return hit || update;
      }));
    }
    return;
  }

  if (e.request.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    e.respondWith(new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        caches.match(e.request).then(hit => {
          if (!settled && hit) { settled = true; resolve(hit); }
        });
      }, 3500);
      fresh(e.request).then(r => {
        clearTimeout(timer);
        if (!settled) { settled = true; resolve(r); }
      }).catch(() => {
        clearTimeout(timer);
        caches.match(e.request).then(hit => { if (!settled) { settled = true; resolve(hit || Response.error()); } });
      });
    }));
    return;
  }

  e.respondWith(caches.match(e.request).then(hit => {
    const update = fresh(e.request).catch(() => hit);
    return hit || update;
  }));
});
