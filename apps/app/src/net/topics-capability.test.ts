import { expect, it, vi } from 'vitest'
import { observeTopics } from './topics-capability'
import type { ProtocolSocket } from '@wechat-cc/protocol'
it('uses topics:v1, never routes:v1, and clears support for every new transport and disconnect', () => {
  let receive!: (s: string) => void, close!: () => void
  const advertise = vi.fn(), downstream = vi.fn()
  const socket: ProtocolSocket = { send() {}, close() {}, onOpen() {}, onMessage: cb => { receive = cb }, onClose: cb => { close = cb } }
  const observed = observeTopics(socket, advertise)
  observed.onMessage(downstream); observed.onClose(() => {})
  receive(JSON.stringify({ hs: 'test', v: 2, routes: 'v1' }))
  expect(advertise).toHaveBeenLastCalledWith(false)
  receive(JSON.stringify({ hs: 'test', v: 2, routes: 'v1', topics: 'v1' }))
  expect(advertise).toHaveBeenLastCalledWith(true)
  receive('{broken'); expect(downstream).toHaveBeenCalledTimes(3)
  close(); expect(advertise).toHaveBeenLastCalledWith(false)
})
