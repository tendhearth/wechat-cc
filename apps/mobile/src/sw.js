// Cache the public interface, never its embedded credential or private API responses.
const CACHE = 'cc-shell-public-v2'
const BRAND_CACHE = 'cc-brand-{{BRAND_ICON_VERSION}}'
function publicShell(html) {
  var match = /^var T = ([^\r\n]+)/m.exec(html)
  if (!match) return null
  var token
  try { token = JSON.parse(match[1].trim().replace(/;$/, '')) } catch (e) { return null }
  if (typeof token !== 'string') return null
  var clean = html.replace(match[0], 'var T = "";try{T=localStorage.getItem("deviceToken")||""}catch(e){}')
  return token && clean.indexOf(token) >= 0 ? null : clean
}
function shellResponse(html) { return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }) }
self.addEventListener('install', function(e){ self.skipWaiting() })
self.addEventListener('activate', function(e){ e.waitUntil((async function(){
  var keys=await caches.keys(),cache=await caches.open(CACHE),saved=await cache.match('shell')
  for(var key of keys){
    if(key.indexOf('cc-shell-')===0&&key!==CACHE){
      if(!saved){var old=await caches.open(key),r=await old.match('shell');if(r){var clean=publicShell(await r.text());if(clean!==null){await cache.put('shell',shellResponse(clean));saved=true}}}
      await caches.delete(key)
    }else if(key.indexOf('cc-brand-')===0&&key!==BRAND_CACHE)await caches.delete(key)
  }
  await self.clients.claim()
})()) })
self.addEventListener('fetch', function(e){
  var url = new URL(e.request.url)
  if (e.request.mode === 'navigate' && url.pathname === '/m') {
    e.respondWith(fetch(e.request).then(async function(r){
      if(r.ok){var clean=publicShell(await r.clone().text());if(clean!==null){var cache=await caches.open(CACHE);await cache.put('shell',shellResponse(clean))}}
      return r
    }).catch(async function(){var cache=await caches.open(CACHE),saved=await cache.match('shell');return saved||new Response('离线，请连接网络后重新打开 CC。',{status:503,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}})}))
    return
  }
  if (url.pathname === '/m/icon.png' || url.pathname === '/m/manifest.json') {
    e.respondWith(caches.open(BRAND_CACHE).then(function(c){ return c.match(e.request).then(function(m){ return m || fetch(e.request).then(function(r){ c.put(e.request, r.clone()); return r }) }) }))
    return
  }
  // Private /v1 responses are never cached here.
})
