// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { RosterResponse } from '@wechat-cc/protocol'
import { makeDemoBackend } from '../backend/demo'
import { cleanup, mount } from '../ui/native-motion.test-support'
import { withProviders } from './providers.test-support'
import { useRoster } from './roster'
vi.mock('react-native', async () => (await import('../ui/native-motion.test-support')).nativeBoundary())
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
it('demo roster validates and contains waiting, working relay, and back', async () => {
  const result = RosterResponse.parse(await makeDemoBackend().roster!())
  expect(result.items.map(i => i.group)).toEqual(['waiting', 'working', 'working', 'back'])
  expect(result.items.some(i => i.relay && i.agents.length > 1)).toBe(true)
})
it('roster events reload; failure retains the previous items and marks stale', async () => {
  const demo = makeDemoBackend()
  let changed: (() => void) | undefined, fail = false
  const roster = vi.fn(async () => { if (fail) throw Error('offline'); return demo.roster!() })
  const backend = { ...demo, roster, subscribe: ((name: string, cb: () => void) => {
    if (name === 'roster') { changed = cb; return () => { changed = undefined } }
    return demo.subscribe(name as 'home', cb)
  }) as typeof demo.subscribe }
  let value!: ReturnType<typeof useRoster>
  function Probe() { value = useRoster(); return null }
  await mount(withProviders(createElement(Probe), { backend })); await flush()
  const previous = value.items
  expect(previous).toHaveLength(4); expect(value.stale).toBe(false)
  fail = true
  await act(() => changed?.()); await flush()
  expect(roster.mock.calls.length).toBeGreaterThan(1)
  expect(value.items).toBe(previous); expect(value.stale).toBe(true); expect(value.error).toBeDefined()
})
