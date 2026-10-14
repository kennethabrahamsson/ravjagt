// Offline: appen selv caches ved installation, kortfliser og vejr caches undervejs.
const VERSION = 'ravjagt-v44';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/model.js', 'js/spots.js', 'js/weather.js', 'js/store.js', 'js/sync.js',
  'data/dk.json', 'vendor/maplibre/maplibre-gl.js', 'vendor/maplibre/maplibre-gl.css', 'vendor/maplibre/maplibre-contour.min.js', 'js/mapview.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'vendor/fonts/outfit-latin.woff2', 'icons/icon-512.png', 'icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'tiles').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Kortfliser: cache først
  // Kun fliser ({z}/{x}/{y}) og skrifttegn (.pbf) – ikke kortets indholdsfortegnelse, som skifter version
  const isTile = /\/\d+\/\d+\/\d+(\.\w+)?$/.test(url.pathname) || /\/fonts\/.+\.pbf$/.test(url.pathname);
  if (isTile && /arcgisonline\.com|openfreemap\.org|elevation-tiles-prod/.test(url.host + url.pathname)) {
    e.respondWith(caches.open('tiles').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === 'opaque') c.put(e.request, res.clone());
      return res;
    }));
    return;
  }

  // Vejr håndteres af appen selv (localStorage), så den går altid til nettet
  if (/open-meteo\.com/.test(url.host)) return;

  // Appen: net først og altid spørg serveren (no-cache), så en ny version når frem med det samme.
  // Uden net bruges den gemte kopi.
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
