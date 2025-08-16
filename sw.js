// sw.js
/* Service Worker renforcé: caches versionnés + allowlist d'origines */
const VERSION = 'v11-hardened';
const PRECACHE = `precache-${VERSION}`;
const RUNTIME_DATA = `data-${VERSION}`;
const RUNTIME_ASSETS = `assets-${VERSION}`;

const ALLOWED_ASSET_ORIGINS = new Set([
  self.location.origin,
  'https://maps.googleapis.com',
  'https://maps.gstatic.com',
  'https://cdn.jsdelivr.net',
  'https://flagcdn.com'
]);

const ALLOWED_DATA_ORIGINS = new Set([
  self.location.origin,
  'https://cdn.jsdelivr.net',
  'https://maps.googleapis.com',
  'https://maps.gstatic.com'
]);

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    await cache.addAll([]); // rien en dur
  })());
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k.includes(VERSION) ? null : caches.delete(k))));
  })());
});

/* Messages:
   - {type:'PRECACHE_URLS', urls:[...]}  -> précharger des URLs (filtrées)
   - {type:'RESET_CACHE'}                -> vider tous les caches */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'PRECACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(PRECACHE);
      const safe = data.urls.filter(u => {
        try { return ALLOWED_ASSET_ORIGINS.has(new URL(u, self.location.href).origin); }
        catch { return false; }
      });
      await cache.addAll(safe);
    })());
  }
  if (data.type === 'RESET_CACHE') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    })());
  }
});

function isDataRequest(req) {
  if (req.method !== 'GET') return false;
  const u = new URL(req.url);
  return (
    (u.pathname.endsWith('.json') ||
     u.pathname.endsWith('.geojson') ||
     u.pathname.endsWith('.topojson'))
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ignore schemes non supportés
  if (url.protocol === 'chrome-extension:' || url.origin === 'null') return;

  // Navigations: Network-first, cache uniquement même origine
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res && res.ok && url.origin === self.location.origin) {
          const cache = await caches.open(RUNTIME_ASSETS);
          cache.put(req, res.clone()).catch(()=>{});
        }
        return res;
      } catch {
        const cache = await caches.open(RUNTIME_ASSETS);
        const hit = await cache.match(req);
        return hit || caches.match('/'); // éventuel index.html si précaché
      }
    })());
    return;
  }

  // Données: Stale-While-Revalidate, allowlist d’origines
  if (isDataRequest(req)) {
    if (!ALLOWED_DATA_ORIGINS.has(url.origin)) return;
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_DATA);
      const cached = await cache.match(req);
      const netPromise = fetch(req, { cache: 'no-store' })
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()).catch(()=>{}); return res; })
        .catch(()=>null);
      return cached || (await netPromise) || Response.error();
    })());
    return;
  }

  // Assets: Network-first, allowlist d’origines
  if (['script','style','image','font','audio','video'].includes(req.destination)) {
    if (!ALLOWED_ASSET_ORIGINS.has(url.origin)) return;
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_ASSETS);
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res && res.ok) cache.put(req, res.clone()).catch(()=>{});
        return res;
      } catch {
        const hit = await cache.match(req);
        return hit || Response.error();
      }
    })());
    return;
  }

  // Par défaut: passe réseau
});
