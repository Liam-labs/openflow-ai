// OpenFlow service worker — network-first with fallback
// Enables PWA installability on Chrome Android without aggressive caching

const CACHE = 'openflow-v1';
const OFFLINE_URL = '/';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([OFFLINE_URL]))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Only handle same-origin GET requests; skip API routes
  if (e.request.method !== 'GET') return;
  const path = new URL(e.request.url).pathname;
  if (path.startsWith('/api/')) return;
  // Riley Voice is its own installed app (public/riley-voice.webmanifest) and needs the live
  // PC: never answer it, or its voice-server calls, with the offline page.
  if (path === '/voice' || path.startsWith('/voice/') || path.startsWith('/riley-voice-rtc/')) return;

  e.respondWith(
    fetch(e.request).catch(() => caches.match(OFFLINE_URL))
  );
});

// Phone notifications (Web Push). The payload is { title, body, url, tag }.
self.addEventListener('push', (e) => {
  let data = {};
  if (e.data) {
    try { data = e.data.json(); } catch (err) { data = { body: e.data.text() }; }
  }
  if (!data || typeof data !== 'object') data = { body: String(data) };
  const options = {
    body: data.body || '',
    data: { url: data.url || '/' },
    icon: '/icons/pwa-192.png',
    badge: '/icons/pwa-192.png',
  };
  if (data.tag) options.tag = data.tag;
  e.waitUntil(self.registration.showNotification(data.title || 'OpenFlow', options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let target = new URL('/', self.location.origin);
  try {
    const wanted = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin);
    if (wanted.origin === self.location.origin) target = wanted;
  } catch (err) { /* keep the home page */ }
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).pathname === target.pathname && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target.href);
    })
  );
});
