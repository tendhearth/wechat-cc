import { expect, test } from 'vitest'
import { createCompanionDrag } from './companion-drag.js'

const point = (screenX: number, screenY: number, buttons = 1, button = 0) => ({ screenX, screenY, buttons, button })

test('landing waits for confirmed movement and an observed release; a later lift supersedes it',async()=>{
  const moving=deferred<void>(),finish=deferred<void>(),events:string[]=[]
  const control=createCompanionDrag({start:async()=>({x:0,y:0}),move:async()=>{events.push('move');moving.resolve()},finish:async()=>{await finish.promise;events.push('saved')},onBegin:()=>events.push('lift'),onEnd:()=>events.push('release'),onLanding:()=>events.push('land'),onError:()=>{}} as any)
  control.press(point(0,0));control.move(point(20,0));await moving.promise
  const completed=control.release(point(20,0,0));await Promise.resolve()
  expect(events).not.toContain('land')
  finish.resolve();await completed
  expect(events.slice(-2)).toEqual(['saved','land'])

  const gate=deferred<void>(),started=deferred<void>();let count=0
  const next=createCompanionDrag({start:async()=>({x:0,y:0}),move:async()=>{started.resolve();await gate.promise},finish:async()=>{},onBegin:()=>{},onEnd:()=>{},onLanding:()=>count++,onError:()=>{}} as any)
  next.press(point(0,0));next.move(point(20,0));await started.promise
  const old=next.release(point(20,0,0));next.press(point(40,0));gate.resolve();await old
  expect(count).toBe(0);await next.cancel()
})

test('drag velocity is bounded; clicks, cancelled moves and missing releases never land',async()=>{
  const speeds:number[]=[],landings:number[]=[]
  const control=createCompanionDrag({start:async()=>({x:0,y:0}),move:async()=>{},finish:async()=>{},onBegin:()=>{},onEnd:()=>{},onVelocity:(v:number)=>speeds.push(v),onLanding:()=>landings.push(1),onError:()=>{}} as any)
  control.press({...point(0,0),timeStamp:0});control.move({...point(100,0),timeStamp:10})
  await control.cancel()
  expect(speeds.length).toBeGreaterThan(0);expect(speeds.every(v=>Number.isFinite(v)&&Math.abs(v)<=1)).toBe(true)
  control.press(point(0,0));await control.release(point(0,0,0))
  control.press(point(0,0));control.move(point(30,0));await control.release()
  expect(landings).toEqual([])
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function fixture(start?: () => Promise<{ x: number; y: number } | null>, move?: (value: { x: number; y: number }) => Promise<void>) {
  let position = { x: 1000, y: 500 }, animating = false, starts = 0, clicks = 0
  const saved: { x: number; y: number }[] = [], errors: unknown[] = []
  const control = createCompanionDrag({
    start: async () => { starts++; return start ? start() : { ...position } },
    move: async (value: { x: number; y: number }) => { await move?.(value); position = { ...value } },
    finish: async () => { saved.push({ ...position }) },
    onBegin: () => { animating = true }, onEnd: () => { animating = false },
    onClick: () => { clicks++ },
    onError: (error: unknown) => { errors.push(error) },
  })
  return { control, saved, errors, position: () => position, animating: () => animating, starts: () => starts, clicks: () => clicks }
}

test('an explicit primary release activates a stationary character once despite duplicate up events', async () => {
  const f = fixture()
  f.control.press(point(100, 100)); f.control.move(point(101, 101))
  await f.control.release(point(101, 101, 0))
  await f.control.release(point(101, 101, 0))
  expect(f.clicks()).toBe(1)
  expect(f.saved).toEqual([])
  expect(f.position()).toEqual({ x: 1000, y: 500 })
})

test('the three-point threshold and a drag returning to its origin never activate chat', async () => {
  const f = fixture()
  f.control.press(point(100, 100)); await f.control.release(point(103, 100, 0))
  f.control.press(point(100, 100)); f.control.move(point(140, 100)); await f.control.release(point(100, 100, 0))
  expect(f.clicks()).toBe(0)
})

test('cancellation and a missing up event never turn a press into activation', async () => {
  const f = fixture()
  f.control.press(point(100, 100)); await f.control.cancel()
  await f.control.release(point(100, 100, 0))
  f.control.press(point(100, 100)); await f.control.move(point(100, 100, 0))
  await f.control.release(point(100, 100, 0))
  expect(f.clicks()).toBe(0)
})

test('a secondary release cannot activate or terminate a primary click candidate', async () => {
  const f = fixture()
  f.control.press(point(100, 100)); await f.control.release(point(100, 100, 0, 2))
  expect(f.clicks()).toBe(0)
  await f.control.release(point(100, 100, 0))
  expect(f.clicks()).toBe(1)
})

test('moves from the native origin using absolute screen displacement and saves after release', async () => {
  const f = fixture()
  expect(f.control.press(point(100, 100))).toBe(true)
  f.control.move(point(80, 90))
  await f.control.release()
  expect(f.position()).toEqual({ x: 980, y: 490 })
  expect(f.saved).toEqual([{ x: 980, y: 490 }])
  expect(f.animating()).toBe(false)
})

test('a stationary click, double-click and small hand jitter never move or persist', async () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) {
    f.control.press(point(100, 100)); f.control.move(point(101, 101))
    await f.control.release()
  }
  expect(f.position()).toEqual({ x: 1000, y: 500 })
  expect(f.saved).toEqual([])
})

test('a fast completed drag waits for its origin; later released motion cannot replace its endpoint', async () => {
  const origin = deferred<{ x: number; y: number }>()
  const f = fixture(() => origin.promise)
  f.control.press(point(100, 100)); f.control.move(point(20, 60))
  const completed = f.control.release()
  f.control.move(point(999, 999, 0))
  origin.resolve({ x: 1000, y: 500 }); await completed
  expect(f.position()).toEqual({ x: 920, y: 460 })
  expect(f.saved).toEqual([{ x: 920, y: 460 }])
})

test('missing mouse-up terminates on buttons=0 without moving toward the released pointer', async () => {
  const f = fixture()
  f.control.press(point(100, 100)); f.control.move(point(80, 80))
  await f.control.move(point(900, 900, 0))
  f.control.move(point(500, 500))
  await f.control.release()
  expect(f.position()).toEqual({ x: 980, y: 480 })
  expect(f.saved).toEqual([{ x: 980, y: 480 }])
  expect(f.animating()).toBe(false)
})

test('blur/cancel before origin resolution discards pending movement', async () => {
  const origin = deferred<{ x: number; y: number }>()
  const f = fixture(() => origin.promise)
  f.control.press(point(100, 100)); f.control.move(point(20, 60))
  const cancelled = f.control.cancel()
  origin.resolve({ x: 1000, y: 500 }); await cancelled
  expect(f.position()).toEqual({ x: 1000, y: 500 })
  expect(f.saved).toEqual([])
  expect(f.animating()).toBe(false)
})

test('a new gesture starts from the preceding confirmed endpoint', async () => {
  const f = fixture()
  f.control.press(point(100, 100)); f.control.move(point(80, 80))
  const first = f.control.release()
  f.control.press(point(200, 200)); f.control.move(point(210, 220))
  await f.control.release(); await first
  expect(f.position()).toEqual({ x: 990, y: 500 })
  expect(f.saved).toEqual([{ x: 980, y: 480 }, { x: 990, y: 500 }])
})

test('in-flight movement coalesces later samples and preserves the release endpoint', async () => {
  const moving = deferred<void>(), settled = deferred<void>()
  const moves: { x: number; y: number }[] = []
  const f = fixture(undefined, async value => {
    moves.push(value)
    if (moves.length === 1) { moving.resolve(); await settled.promise }
  })
  f.control.press(point(100, 100)); f.control.move(point(90, 100)); await moving.promise
  f.control.move(point(80, 100)); f.control.move(point(60, 100))
  const completed = f.control.release(point(20, 100, 0))
  settled.resolve(); await completed
  expect(moves).toEqual([{ x: 990, y: 500 }, { x: 920, y: 500 }])
  expect(f.saved).toEqual([{ x: 920, y: 500 }])
})

test('cancelling an in-flight move discards queued samples and saves only the confirmed position', async () => {
  const moving = deferred<void>(), settled = deferred<void>()
  const moves: { x: number; y: number }[] = []
  const f = fixture(undefined, async value => { moves.push(value); moving.resolve(); await settled.promise })
  f.control.press(point(100, 100)); f.control.move(point(90, 100)); await moving.promise
  f.control.move(point(20, 100)); const cancelled = f.control.cancel()
  settled.resolve(); await cancelled
  expect(moves).toEqual([{ x: 990, y: 500 }])
  expect(f.saved).toEqual([{ x: 990, y: 500 }])
  expect(f.animating()).toBe(false)
})

test('a later native failure still saves preceding confirmed movement and allows another gesture', async () => {
  const first = deferred<void>(), failing = deferred<void>()
  let moves = 0
  const f = fixture(undefined, async () => {
    moves++
    if (moves === 1) first.resolve()
    if (moves === 2) { failing.resolve(); throw Error('second move unavailable') }
  })
  f.control.press(point(100, 100)); f.control.move(point(90, 100)); await first.promise
  f.control.move(point(20, 100)); await failing.promise; await f.control.release()
  expect(f.saved).toEqual([{ x: 990, y: 500 }])
  expect(f.errors).toHaveLength(1)
  expect(f.animating()).toBe(false)
  f.control.press(point(100, 100)); f.control.move(point(110, 100)); await f.control.release()
  expect(f.saved).toEqual([{ x: 990, y: 500 }, { x: 1000, y: 500 }])
})

test('native-managed dragging stays native on platforms that return no manual origin', async () => {
  const f = fixture(async () => null)
  f.control.press(point(100, 100)); f.control.move(point(20, 60))
  await f.control.release()
  expect(f.starts()).toBe(1)
  expect(f.position()).toEqual({ x: 1000, y: 500 })
  expect(f.saved).toEqual([])
})

test('secondary buttons and invalid input never start a native operation', async () => {
  const f = fixture()
  for (const value of [point(0, 0, 2, 2), point(NaN, 0), point(0, Infinity)]) expect(f.control.press(value)).toBe(false)
  await f.control.release()
  expect(f.starts()).toBe(0)
  expect(f.saved).toEqual([])
})

test('a native failure ends the gesture and allows the next drag', async () => {
  let failed = false
  const f = fixture(async () => {
    if (!failed) { failed = true; throw Error('native unavailable') }
    return { x: 1000, y: 500 }
  })
  f.control.press(point(100, 100)); await f.control.release()
  expect(f.animating()).toBe(false); expect(f.errors).toHaveLength(1)
  f.control.press(point(100, 100)); f.control.move(point(120, 130)); await f.control.release()
  expect(f.position()).toEqual({ x: 1020, y: 530 })
})
