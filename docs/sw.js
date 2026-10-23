/* 離線快取：殼層 cache-first，資料與 PDF network-first（斷網時用上次的） */
const VER = 'v4';
const SHELL = ['./', 'index.html', 'style.css?v=4', 'app.js?v=4', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open('shell-' + VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !k.endsWith(VER)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  if (/\/data\/|\.pdf$/.test(p)) {
    // network-first；快取鍵去掉 query，離線時能找到
    const key = new Request(url.origin + p);
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) caches.open('data-' + VER).then(c => c.put(key, r.clone()));
      return r;
    }).catch(() => caches.match(key).then(r => r || new Response('', { status: 503 }))));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: false }).then(r => r || fetch(e.request).then(res => {
    if (res.ok && e.request.method === 'GET') caches.open('shell-' + VER).then(c => c.put(e.request, res.clone()));
    return res;
  })));
});
