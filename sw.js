/* Keeps a copy of the app's own files so it opens without a connection.
   Diary data is never stored here. Raise the version to force a refresh. */
var CACHE = 'life-diary-v15';
var FILES = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // cache: 'reload' skips the browser's own cache, so a new version stores new files.
      return Promise.all(FILES.map(function (f) { return cache.add(new Request(f, { cache: 'reload' })).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* Network first, so updates arrive; the saved copy answers when offline or slow. */
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      var fromCache = cache.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || (req.mode === 'navigate' ? cache.match('./') : undefined);
      });
      var fromNetwork = fetch(req, { cache: 'no-cache' }).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      });
      var slow = new Promise(function (resolve) { setTimeout(resolve, 3000); }).then(function () { return fromCache; });
      return Promise.race([fromNetwork, slow.then(function (hit) { return hit || fromNetwork; })])
        .catch(function () { return fromCache.then(function (hit) { return hit || Response.error(); }); });
    })
  );
});
