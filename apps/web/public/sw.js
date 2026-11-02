/* NextAi service worker: app-shell caching, offline fallback, web push. API calls are never cached. */
const VERSION = 'nx-v1';
const SHELL = ['/', '/capture', '/approvals', '/offline', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // API (other origin) is never cached
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/brand/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match(req).then((hit) => hit || caches.match('/offline'))));
  }
});
self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : { title: 'NextAi', body: 'You have an update.' };
  e.waitUntil(self.registration.showNotification(data.title || 'NextAi', { body: data.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: data.url || '/' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data.url));
});
