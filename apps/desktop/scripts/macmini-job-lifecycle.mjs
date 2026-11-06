// Keep the machine lock until owned process groups have stopped, including on signals.
export function jobLifecycle({ processRef = process, setTimer = setTimeout, clearTimer = clearTimeout,
  timeoutMs = Number(process.env.CC_UI_JOB_TIMEOUT_MS ?? 14400000) } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('Invalid job timeout')
  const children = new Set()
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
  const stop = async code => {
    if (stopping) return
    stopping = true
    const running = [...children]
    const done = Promise.all(running.map(child => new Promise(resolve => child.once('close', resolve))))
    const kill = signal => { for (const child of running) { try { processRef.kill(-child.pid, signal) } catch {} } }
    kill('SIGTERM')
    const escalation = setTimer(() => kill('SIGKILL'), 5000)
    await done
    clearTimer(escalation)
    try { await cleanup() } finally { await finish() }
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
    track: child => { children.add(child); child.once('close', () => children.delete(child)); return child },
    finish: () => stopping ? stopPromise : finish(),
  }
}
