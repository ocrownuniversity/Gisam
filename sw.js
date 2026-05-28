// ── FUJUP VENTURE — SERVICE WORKER ──────────────────────────────────────────
// Strategy:
//   • App shell (index.html, fonts) → Cache First (works 100% offline)
//   • Firebase SDK scripts → Cache First (CDN, rarely change)
//   • Google Fonts → Cache First
//   • Firebase Firestore API calls → Network Only (data must be live or use app's own offline queue)
//   • Everything else → Network falling back to cache

const CACHE_NAME = 'fujup-v1';
const SHELL_URLS = [
  './',
  './index.html',
];

// External resources to pre-cache for offline use
const CDN_URLS = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore-compat.js',
];

// ── INSTALL: cache the app shell ─────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // Cache shell URLs (must succeed)
      await cache.addAll(SHELL_URLS);
      // Cache CDN URLs best-effort (don't fail install if CDN is slow)
      await Promise.allSettled(
        CDN_URLS.map(url =>
          fetch(url, { mode: 'cors' })
            .then(res => { if(res.ok) cache.put(url, res); })
            .catch(() => console.warn('[SW] Could not pre-cache:', url))
        )
      );
      console.log('[SW] App shell cached');
    })
  );
  // Activate immediately — don't wait for old SW to finish
  self.skipWaiting();
});

// ── ACTIVATE: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => { console.log('[SW] Deleting old cache:', key); return caches.delete(key); })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: routing strategy ───────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Firebase Firestore / Auth API → Network Only (never cache live DB calls)
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebase.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com') ||
    url.pathname.includes('/v1/projects/')
  ) {
    // Let the app's own offline queue handle failures — just pass through
    event.respondWith(fetch(event.request).catch(() => new Response(
      JSON.stringify({ error: 'offline' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )));
    return;
  }

  // 2. App shell & same-origin files → Cache First, then Network
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          // Cache valid responses
          if (response && response.status === 200 && response.type !== 'opaque') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => {
          // For navigation requests, return index.html as fallback
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
    );
    return;
  }

  // 3. Google Fonts & Firebase SDK (CDN) → Cache First
  if (
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('gstatic.com')
  ) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached); // return stale if network fails
      })
    );
    return;
  }

  // 4. Everything else → Network with cache fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── ONLINE/OFFLINE NOTIFICATIONS → tell the app ──────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
