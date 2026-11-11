// Device-only, read-only activity. Drafts stay local; Light/Dark is still owned by presence.js.
var mobileCC = window.mobileCC = (function () {
  var tracker = CCP.createCCActivity(), response = CCP.createCCResponsePerformance()
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  var running = false, inFlight = false, generation = 0, cursor = 0, scope = '', identity = '', primed = false, healthy = false
  var focused = true, online = navigator.onLine !== false, typingUntil = -Infinity, pollTimer, frameTimer
  var input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('chat-input'))
  function available() {
    var cc = document.getElementById('small-cc')
    return isDevice && cReady && !document.hidden && focused && online && !mOffline && !!cc && cc.classList.contains('lit')
  }
  function render() {
    clearTimeout(frameTimer)
    var now = Date.now(), connected = available() && healthy
    var phase = tracker.phase({ connected: connected, typing: now < typingUntil, waiting: Array.isArray(cWaitingRows) && cWaitingRows.length > 0, now: now })
    var frame = response.frame(phase, now, connected && !motion.matches)
    var cc = document.getElementById('small-cc'), label = { listening: '关注输入', thinking: '处理', speaking: '回应文字' }
    if (cc) {
      cc.dataset.ccPhase = phase; cc.dataset.ccResponse = frame === null ? 'static' : 'acting'
      cc.setAttribute('aria-label', '返回和 CC 的对话' + (label[phase] ? '，CC 正在' + label[phase] : ''))
    }
    if (phase !== 'idle') frameTimer = setTimeout(render, 100)
  }
  function stopTyping() { typingUntil = -Infinity; render() }
  function stop() {
    running = false; generation++; identity = ''; cursor = 0; scope = ''; primed = false; healthy = false; typingUntil = -Infinity
    clearTimeout(pollTimer); tracker.observe(null, Date.now(), false); render()
  }
  async function poll(token) {
    if (!running || inFlight) return
    inFlight = true
    var sent = T
    try {
      var r = await /* link-scan: device-only */ api('/v1/matter/owner-chat/events?since=' + cursor)
      if (!running || token !== generation || sent !== T || !available()) return
      if (r.status === 401) { onUnauthorized(sent); throw Error() }
      if (r.status < 200 || r.status >= 300) throw Error()
      var value = await r.json()
      if (!running || token !== generation || sent !== T || !available()) return
      if (!Array.isArray(value.events) || !Number.isSafeInteger(value.cursor) || value.cursor < 0 || (value.running !== null && typeof value.running?.turnId !== 'string')) throw Error()
      if (scope && value.scope && scope !== value.scope) {
        stop(); refresh(); return
      }
      scope = value.scope || scope; cursor = value.cursor; healthy = true
      tracker.observe({ scope: identity + ':' + scope, running: value.running, events: value.events, activityReady: primed }, Date.now())
      if (!value.events.length) primed = true
      render()
    } catch (error) {
      if (running && token === generation) { primed = false; healthy = false; tracker.observe(null, Date.now(), false); render() }
    } finally {
      inFlight = false
      if (running) {
        if (token === generation) pollTimer = setTimeout(function () { void poll(token) }, 1000)
        else void poll(generation)
      }
    }
  }
  function refresh() {
    if (!available()) { if (running || identity) stop(); else render(); return }
    var next = T + ':' + cPrivacyRevision + ':' + cOwnerMatterId
    if (running && identity === next) { render(); return }
    stop(); identity = next; running = true; void poll(++generation)
  }
  input?.addEventListener('input', function () {
    typingUntil = input === document.activeElement && !!input.value.trim() && !input.disabled ? Date.now() + CCP.CC_ACTIVITY.typingMs : -Infinity
    render()
  })
  input?.addEventListener('blur', stopTyping)
  document.getElementById('chat-form')?.addEventListener('submit', stopTyping, true)
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else refresh() })
  window.addEventListener('blur', function () { focused = false; stop() })
  window.addEventListener('focus', function () { focused = true; refresh() })
  window.addEventListener('offline', function () { online = false; stop() })
  window.addEventListener('online', function () { online = true; refresh() })
  motion.addEventListener('change', render)
  setInterval(refresh, 500)
  refresh()
  return { refresh: refresh, stop: stop }
})()
