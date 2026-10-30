// @ts-check
// Window origins and browser screen coordinates are logical points on macOS.
// Serialize gestures and coalesce motion while the preceding native move settles.
/** @typedef {{ x: number, y: number }} Position */
/** @typedef {{ screenX: number, screenY: number, buttons?: number, button?: number }} DragPoint */
/** @typedef {{ pressed: DragPoint, pending: Position | null, dragged: boolean, moved: boolean, ended: boolean, cancelled: boolean, wake: (() => void) | null, done: Promise<void> }} Gesture */
/** @param {{ start: () => Promise<Position | null | undefined>, move: (position: Position) => Promise<unknown>, finish: () => Promise<unknown>, onBegin: () => void, onEnd: () => void, onError: (error: unknown) => void }} callbacks */
export function createCompanionDrag({ start, move: moveNative, finish, onBegin, onEnd, onError }) {
  /** @type {Gesture | null} */
  let active = null
  let tail = Promise.resolve()
  /** @param {DragPoint} point */
  const finite = point => point && Number.isFinite(point.screenX) && Number.isFinite(point.screenY)
  /** @param {Gesture} gesture */
  const wake = gesture => { gesture.wake?.(); gesture.wake = null }
  /** @param {Gesture} gesture @param {DragPoint} point */
  const update = (gesture, point) => {
    if (!finite(point)) return
    const delta = { x: point.screenX - gesture.pressed.screenX, y: point.screenY - gesture.pressed.screenY }
    if (Math.hypot(delta.x, delta.y) >= 3) gesture.dragged = true
    if (gesture.dragged) { gesture.pending = delta; wake(gesture) }
  }
  /** @param {DragPoint} [point] */
  function release(point) {
    const gesture = active
    if (!gesture) return tail
    if (point && point.button !== undefined && point.button !== 0) return Promise.resolve()
    if (point) update(gesture, point)
    active = null; gesture.ended = true; onEnd(); wake(gesture)
    return gesture.done
  }
  function cancel() {
    const gesture = active
    if (!gesture) return tail
    active = null; gesture.pending = null; gesture.cancelled = true; gesture.ended = true
    onEnd(); wake(gesture)
    return gesture.done
  }
  return {
    /** @param {DragPoint} point */
    press(point) {
      if (!finite(point) || (point.button ?? 0) !== 0) return false
      cancel()
      const previous = tail
      /** @type {Gesture} */
      const gesture = { pressed: { screenX: point.screenX, screenY: point.screenY }, pending: null,
        dragged: false, moved: false, ended: false, cancelled: false, wake: null, done: Promise.resolve() }
      active = gesture; onBegin()
      gesture.done = (async () => {
        await previous
        const origin = await start()
        // Other desktop platforms keep their existing system-managed drag path.
        if (origin == null) return
        if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) throw Error('Invalid native companion drag origin')
        /** @type {Position | null} */ let applied = null
        while (!gesture.cancelled) {
          if (gesture.pending) {
            const delta = gesture.pending; gesture.pending = null
            if (!applied || delta.x !== applied.x || delta.y !== applied.y) {
              await moveNative({ x: origin.x + delta.x, y: origin.y + delta.y })
              applied = delta; gesture.moved = true
            }
            continue
          }
          if (gesture.ended) break
          /** @type {Promise<void>} */
          const waiting = new Promise(resolve => { gesture.wake = resolve })
          await waiting
        }
      })().catch(error => {
        gesture.cancelled = true
        if (active === gesture) { active = null; onEnd() }
        onError(error)
      }).finally(async () => {
        // A later failed move must not discard earlier confirmed movement.
        if (gesture.moved) await finish()
      }).catch(onError)
      tail = gesture.done
      return true
    },
    /** @param {DragPoint} point */
    move(point) {
      if (!active) return
      if (((point.buttons ?? 0) & 1) === 0) return release()
      update(active, point)
    },
    release, cancel,
  }
}
