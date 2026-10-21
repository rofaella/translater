// Service Worker: сохраняет саму страницу, worker.js и библиотеку Transformers.js с CDN,
// чтобы приложение открывалось без интернета. Файлы моделей кэширует сама библиотека.
const SHELL_CACHE = 'translator-shell-v1';
const CDN_CACHE = 'translator-cdn-v1';
const SHELL = ['./', './index.html', './worker.js', './manifest.json', './icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) { return k.indexOf('translator-') === 0 && k !== SHELL_CACHE && k !== CDN_CACHE; })
            .map(function (k) { return caches.delete(k); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isCdn = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !isCdn) return; // Hugging Face и остальное не трогаем

  if (isCdn) {
    // Версии в адресах зафиксированы, поэтому сначала кэш.
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CDN_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  // Свои файлы: сначала сеть (чтобы получать обновления), без сети берём из кэша.
  e.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (hit) {
          return hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined);
        });
      })
  );
});
