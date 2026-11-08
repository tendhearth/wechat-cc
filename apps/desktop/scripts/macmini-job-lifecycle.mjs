// Keep the machine lock until owned process groups have stopped, including on signals.
export function jobLifecycle({ processRef = process, setTimer = setTimeout, clearTimer = clearTimeout,
  timeoutMs = Number(process.env.CC_UI_JOB_TIMEOUT_MS ?? 14400000) } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('Invalid job timeout')
  const children = new Map()
  let cleanup = async () => {}
  let release = async () => {}
  let stopping = false
  let stopPromise
  let watchdog
  const handlers = []
  const finish = async () => {
    clearTimer(watchdog)
    for (const [signal, handler] of handlers) processRef.removeListener(signal, handler)
    await release()
  }
  const terminate = owned => {
    if (owned.terminating) return
    owned.terminating = true
    const kill = signal => { try { processRef.kill(-owned.child.pid, signal) } catch {} }
    kill('SIGTERM')
    owned.escalation = setTimer(() => kill('SIGKILL'), 5000)
  }
  const drain = async () => {
    while (children.size) await Promise.all([...children.values()].map(owned => owned.done))
  }
  const stop = async code => {
    if (stopping) return
    stopping = true
    for (const owned of children.values()) terminate(owned)
    await drain()
    try { await cleanup() } finally { await drain(); await finish() }
    processRef.exit(code)
  }
  const requestStop = code => { stopPromise ??= stop(code); return stopPromise }
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const handler = () => { void requestStop(code) }
    handlers.push([signal, handler])
    processRef.on(signal, handler)
  }
  watchdog = setTimer(() => { void requestStop(124) }, timeoutMs)
  watchdog.unref?.()
  return {
    onStop: value => { cleanup = value },
    assertRunning: () => { if (stopping) throw Error('Mini job is stopping') },
    acquired: value => { release = value },
    track: child => {
      const owned = { child, done: null, terminating: false, escalation: null }
      owned.done = new Promise(resolve => child.once('close', () => {
        clearTimer(owned.escalation)
        children.delete(child)
        resolve()
      }))
      children.set(child, owned)
      // A late spawn is never admitted as new work while stopping. Keep its
      // close receipt only so the machine lock cannot outlive its process group.
      if (stopping) terminate(owned)
      return child
    },
    finish: () => stopping ? stopPromise : finish(),
  }
}
