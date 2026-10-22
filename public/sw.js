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
