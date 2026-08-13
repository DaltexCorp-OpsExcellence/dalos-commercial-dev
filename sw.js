/* ══════════════════════════════════════════════════════════════════════════
   DalOS Commercial — service worker.
   Purpose: make Show Mode (stand lead capture) survive dead venue wifi.

   Strategy
   ────────
   • PRECACHE the app shell on install (index.html, crm.js, the self-hosted
     capture libs, manifest, capture icons) so a home-screen relaunch works
     with zero connectivity.
   • RUNTIME cache-first for everything else fetched (fonts, the React CDN,
     Tesseract's lazily-loaded worker/wasm/eng-traineddata) — one online OCR
     therefore caches the ~15 MB of Tesseract runtime assets so later OCR
     works offline. Opaque cross-origin responses are cacheable and are stored.
   • Supabase (auth + REST/RPC + storage) is NEVER cached — always network,
     so data is never served stale and offline reads simply fail (the app's
     own IndexedDB offline queue is the source of truth for captures).
   • The app document + crm.js use network-first (fall back to cache) so a new
     deploy is picked up as soon as there's a signal, but the app still opens
     offline from cache.

   Versioned cache name; old caches are purged on activate.
   ══════════════════════════════════════════════════════════════════════════ */
var CACHE = 'dalos-commercial-v1';

/* App shell — relative paths so they resolve under the GitHub Pages subpath
   (/dalos-commercial-dev/). These are the files capture needs to boot offline. */
var SHELL = [
  './',
  'index.html',
  'crm.js',
  'manifest.webmanifest',
  'lib/jsQR.js',
  'lib/qrcode.min.js',
  'lib/tesseract.min.js',
  'capture-icon-152.png',
  'capture-icon-167.png',
  'capture-icon-180.png',
  'capture-icon-192.png',
  'capture-icon-512.png'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      /* Best-effort precache: one missing/renamed asset must not abort the whole
         install, or the SW never activates. Cache each individually. */
      return Promise.all(SHELL.map(function(u){
        return c.add(new Request(u, {cache:'reload'})).catch(function(){});
      }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){ if(k!==CACHE) return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

function isSupabase(url){ return /supabase\.(co|in)/i.test(url.host); }

/* Same-origin document / crm.js → network-first (fresh deploy wins, cache is the
   offline fallback). */
function networkFirst(req){
  return fetch(req).then(function(res){
    if(res && (res.ok || res.type==='opaque')){
      var copy=res.clone(); caches.open(CACHE).then(function(c){ c.put(req, copy); });
    }
    return res;
  }).catch(function(){
    return caches.match(req).then(function(hit){
      if(hit) return hit;
      /* navigations offline → fall back to the cached shell */
      if(req.mode==='navigate') return caches.match('index.html') || caches.match('./');
      return Response.error();
    });
  });
}

/* Everything else (libs, fonts, React CDN, Tesseract worker/wasm/lang) →
   cache-first, populate the runtime cache on first fetch. */
function cacheFirst(req){
  return caches.match(req).then(function(hit){
    if(hit) return hit;
    return fetch(req).then(function(res){
      if(res && (res.ok || res.type==='opaque')){
        var copy=res.clone(); caches.open(CACHE).then(function(c){ c.put(req, copy); });
      }
      return res;
    });
  });
}

self.addEventListener('fetch', function(e){
  var req=e.request;
  if(req.method!=='GET') return;                 /* writes/auth → passthrough */
  var url;
  try{ url=new URL(req.url); }catch(err){ return; }
  if(url.protocol!=='http:' && url.protocol!=='https:') return;
  if(isSupabase(url)) return;                     /* never cache live data */

  var sameOrigin=(url.origin===self.location.origin);
  var isDoc=(req.mode==='navigate') || /\/(index\.html)?$/.test(url.pathname) && req.headers.get('accept')&&req.headers.get('accept').indexOf('text/html')>=0;
  var isAppCode=sameOrigin && /(^|\/)(index\.html|crm\.js)$/.test(url.pathname);

  if(isDoc || isAppCode){ e.respondWith(networkFirst(req)); return; }
  e.respondWith(cacheFirst(req));
});
