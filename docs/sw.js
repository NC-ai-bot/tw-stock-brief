/* 離線快取：殼層 cache-first，資料與 PDF network-first（斷網時用上次的） */
const VER = 'v20';
const SHELL = ['./', 'index.html', 'style.css?v=20', 'app.js?v=20', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

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

/* 推播 */
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: '晨報', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '選股晨報', { body: d.body || '', tag: d.tag || undefined, data: { url: d.url || './' }, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', renotify: !!d.tag }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => { const c = list.find(x => x.url.includes('/tw-stock-brief/')); if (c) { c.navigate(url); return c.focus(); } return self.clients.openWindow(url); }));
});
