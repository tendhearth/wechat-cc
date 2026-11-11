// Device-only, read-only activity. Drafts stay local; Light/Dark is still owned by presence.js.
var mobileCC = window.mobileCC = (() => {
  var tracker = CCP.createCCActivity(), response = CCP.createCCResponsePerformance()
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  var running = false, inFlight = false, generation = 0, cursor = 0, scope = '', identity = '', primed = false, healthy = false, failures = 0
  var focused = true, online = navigator.onLine !== false, typingUntil = -Infinity, pollTimer, frameTimer
  var input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('chat-input'))
  var cc = document.getElementById('small-cc')
  function available() {
    return isDevice && cReady && !document.hidden && focused && online && !mOffline && !!cc && cc.classList.contains('lit')
  }
  function render() {
    clearTimeout(frameTimer)
    var now = Date.now(), connected = available() && healthy
    var phase = tracker.phase({ connected: connected, typing: now < typingUntil, waiting: cWaitingMatters().length > 0, now: now })
    var frame = response.frame(phase, now, connected && !motion.matches)
    var label = { listening: '关注输入', thinking: '处理', speaking: '回应文字' }[phase]
    if (cc) {
      cc.dataset.ccPhase = phase; cc.dataset.ccResponse = frame === null ? 'static' : 'acting'
      cc.setAttribute('aria-label', '返回和 CC 的对话' + (label ? '，CC 正在' + label : ''))
    }
    if (phase !== 'idle') frameTimer = setTimeout(render, 100)
  }
  function stopTyping() { typingUntil = -Infinity; render() }
  function clearActivity() { primed = healthy = false; tracker.observe(null, Date.now(), false); render() }
  function stop() {
    running = false; generation++; identity = scope = ''; cursor = failures = 0; typingUntil = -Infinity
    clearTimeout(pollTimer); clearActivity()
  }
  function current(token, sent) { return running && token === generation && sent === T && available() }
  async function poll(token) {
    if (!running || inFlight) return
    inFlight = true
    var sent = T, delay = 1000
    try {
      var r = await /* link-scan: device-only */ api('/v1/matter/owner-chat/events?since=' + cursor)
      if (!current(token, sent)) return
      if (r.status === 401) onUnauthorized(sent)
      if (r.status < 200 || r.status >= 300) throw Error()
      var value = await r.json()
      if (!current(token, sent)) return
      if (!Array.isArray(value.events) || !Number.isSafeInteger(value.cursor) || value.cursor < 0 || (value.running !== null && typeof value.running?.turnId !== 'string')) throw Error()
      if (scope && value.scope && scope !== value.scope) {
        stop(); refresh(); return
      }
      scope = value.scope || scope; cursor = value.cursor; healthy = true; failures = 0
      tracker.observe({ scope: identity + ':' + scope, running: value.running, events: value.events, activityReady: primed }, Date.now())
      if (!value.events.length) primed = true
      render()
    } catch (error) {
      if (current(token, sent)) {
        // Jitter the capped 50s base by 0–20%, including at the cap (at most 60s).
        // A server Retry-After may ask for longer.
        delay = Math.min(50000, 1000 * 2 ** Math.min(failures++, 6)) * (1 + Math.random() / 5)
        var retry = r?.headers?.get('Retry-After')
        var after = retry && (/^\d+$/.test(retry) ? +retry * 1000 : Date.parse(retry) - Date.now())
        if (Number.isFinite(after)) delay = Math.max(delay, after)
        clearActivity()
      }
    } finally {
      inFlight = false
      if (running) {
        if (token === generation) pollTimer = setTimeout(() => poll(token), delay)
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
  input?.addEventListener('input', () => {
    typingUntil = input === document.activeElement && !!input.value.trim() && !input.disabled ? Date.now() + CCP.CC_ACTIVITY.typingMs : -Infinity
    render()
  })
  input?.addEventListener('blur', stopTyping)
  document.getElementById('chat-form')?.addEventListener('submit', stopTyping, true)
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else refresh() })
  window.addEventListener('blur', () => { focused = false; stop() })
  window.addEventListener('focus', () => { focused = true; refresh() })
  window.addEventListener('offline', () => { online = false; stop() })
  window.addEventListener('online', () => { online = true; refresh() })
  motion.addEventListener('change', render)
  setInterval(refresh, 500)
  refresh()
  return { refresh: refresh, stop: stop }
})()
