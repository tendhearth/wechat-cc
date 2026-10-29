// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ReplyAttachments } from './ReplyExtras'
import { withProviders } from '../state/providers.test-support'
import { makeDemoBackend } from '../backend/demo'
import { cleanup, mount } from './native-motion.test-support'
const native = vi.hoisted(() => ({ sizeReads: 0, panorama: false }))
vi.mock('react-native', async () => {
  const boundary = (await import('./native-motion.test-support')).nativeBoundary()
  const Image = Object.assign((props: any) => createElement('img', { src: props.source.uri, 'data-testid': props.testID, 'data-style': JSON.stringify(props.style) }), { getSize: (_: string, ok: (w: number, h: number) => void, fail: (e: Error) => void) => native.panorama ? ok(2400, 100) : ++native.sizeReads === 1 ? ok(120, 80) : fail(new Error('decode failed')) })
  return { ...boundary, Image, ActivityIndicator: () => null }
})
vi.mock('react-native-safe-area-context', async () => { const { View } = await import('./native-motion.test-support'); return { SafeAreaView: View, SafeAreaProvider: View } })
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digest: async (_: string, bytes: Uint8Array) => { const hash = createHash('sha256').update(bytes).digest(); return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) } }))
vi.mock('expo-audio', () => ({ createAudioPlayer: vi.fn(), setAudioModeAsync: vi.fn() }))
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }))
afterEach(cleanup)
it('shows a recoverable error when a verified inline attachment cannot open in the full-screen image viewer', async () => {
  native.sizeReads = 0; native.panorama = false
  const bytes = Buffer.from('verified image fixture')
  const backend = makeDemoBackend({ lang: 'en' })
  backend.chatFileChunk = async () => ({ name: 'picture.png', mime: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), offset: 0, nextOffset: bytes.length, contentBase64: bytes.toString('base64') })
  const ui = await mount(withProviders(createElement(ReplyAttachments, { messageId: 'message-1', items: [{ kind: 'file', name: 'picture.png' }], lang: 'en' }), { backend, lang: 'en' }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  await act(() => ui.byId('chat-att-image').click())
  expect(ui.byId('chat-att-image-note')?.textContent).toContain("Couldn't open")
  expect((ui.byId('chat-att-image') as HTMLButtonElement).disabled).toBe(false)
})

for (const messageId of ['incoming-user-message', 'cc-message']) it(`opens a panoramic attachment from a minimum 44pt target without stretching its ratio (${messageId})`, async () => {
  native.panorama = true
  const bytes = Buffer.from('verified panoramic image')
  const backend = makeDemoBackend({ lang: 'en' })
  const load = vi.fn(async () => ({ name: 'panorama.png', mime: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), offset: 0, nextOffset: bytes.length, contentBase64: bytes.toString('base64') }))
  backend.chatFileChunk = load
  const ui = await mount(withProviders(createElement(ReplyAttachments, { messageId, items: [{ kind: 'file', name: 'panorama.png' }], lang: 'en' }), { backend, lang: 'en' }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(ui.style('chat-att-image').minHeight).toBeGreaterThanOrEqual(44)
  expect(ui.style('chat-att-image-content').aspectRatio).toBe(24)
  expect(ui.style('chat-att-image-content').width).toBe('100%')
  expect(load).toHaveBeenCalledWith({ messageId, index: 0, offset: 0 })
  await act(() => ui.byId('chat-att-image').click())
  expect(ui.byId('artifact-image')).not.toBeNull()
  expect(ui.style('artifact-image').aspectRatio).toBe(24)
  expect(ui.byId('artifact-close')).not.toBeNull()
})
