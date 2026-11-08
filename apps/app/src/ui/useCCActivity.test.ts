// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useCCActivity } from './useCCActivity'
import { advance, cleanup, mount, resetHost } from './native-motion.test-support'
import type { CCStream } from '@wechat-cc/protocol'
beforeEach(() => { resetHost(); vi.useFakeTimers() })
afterEach(cleanup)
function Probe({ stream, enabled = true }: { stream?: CCStream; enabled?: boolean }) {
  return createElement('span', { 'data-phase': useCCActivity(stream, true, enabled, false, false) })
}
const stream = (text = ''): CCStream => ({ running: { turnId: 't' }, events: text ? [{ id: 'e', turnId: 't', kind: 'agent_message', text }] : [] })
it('never renews stale running evidence on a motion/lifecycle toggle', async () => {
  const old = stream()
  const ui = await mount(createElement(Probe, { stream: old }))
  const phase = () => ui.container.firstElementChild!.getAttribute('data-phase')
  expect(phase()).toBe('thinking')
  await advance(2500); expect(phase()).toBe('idle')
  await ui.render(createElement(Probe, { stream: old, enabled: false }))
  await ui.render(createElement(Probe, { stream: old, enabled: true }))
  expect(phase()).toBe('idle')
  await ui.render(createElement(Probe, { stream: stream() })); expect(phase()).toBe('thinking')
  await ui.render(createElement(Probe, { stream: stream('new') })); expect(phase()).toBe('speaking')
  await advance(900); expect(phase()).toBe('thinking')
  await ui.render(createElement(Probe)); expect(phase()).toBe('idle')
})
