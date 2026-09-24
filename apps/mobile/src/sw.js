
const CACHE = 'cc-shell-v1'
// Rotate static brand assets with the PNG; preserve the paired offline shell.
const BRAND_CACHE = 'cc-brand-{{BRAND_ICON_VERSION}}'
self.addEventListener('install', function(e){ self.skipWaiting() })
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()) })
self.addEventListener('fetch', function(e){
  var url = new URL(e.request.url)
  if (e.request.mode === 'navigate' && url.pathname === '/m') {
    // network-first for the shell; cache the tokened doc; fall back offline.
    e.respondWith(fetch(e.request).then(function(r){
      var copy = r.clone(); caches.open(CACHE).then(function(c){ c.put('shell', copy) }); return r
    }).catch(function(){ return caches.open(CACHE).then(function(c){ return c.match('shell') }).then(function(m){ return m || new Response('离线且没有缓存,请先在家里打开一次', { status: 503 }) }) }))
    return
  }
  if (url.pathname === '/m/icon.png' || url.pathname === '/m/manifest.json') {
    e.respondWith(caches.open(BRAND_CACHE).then(function(c){ return c.match(e.request).then(function(m){ return m || fetch(e.request).then(function(r){ c.put(e.request, r.clone()); return r }) }) }))
    return
  }
  // /m/api/* and everything else — let the page decide (LAN → tunnel).
})
