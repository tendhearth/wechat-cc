// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../ui/native-motion.test-support'
import { makeDemoBackend } from '../backend/demo'
import { BackendError, type Backend, type CliSessionRowT } from '../backend/types'
import TerminalSession from '../app/terminal/[id]'
import { clearDrafts, setPairingScope } from './drafts'
import { withProviders } from './providers.test-support'

const host = vi.hoisted(() => ({ id: 'terminal-a' }))
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (container: Element) => { render(node: ReactNode): void; unmount(): void }

vi.mock('react-native', async () => {
  const { createElement, forwardRef } = await import('react')
  const native = (await import('../ui/native-motion.test-support')).nativeBoundary()
  const View = ({ children, testID, accessibilityLabel }: any) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children)
  const TextInput = forwardRef<any, any>(({ value, onChangeText, editable, testID }: any, ref) => createElement('textarea', {
    ref, value, readOnly: editable === false, 'data-testid': testID, onInput: (event: any) => onChangeText(event.currentTarget.value),
  }))
  return { ...native, View, TextInput, ScrollView: View, KeyboardAvoidingView: View, ActivityIndicator: View }
})
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: any) => createElement('main', null, children) }))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('expo-router', async () => ({
  ...(await (await import('../ui/native-motion.test-support')).routerBoundary()),
  useLocalSearchParams: () => ({ id: host.id }),
  useRouter: () => ({ canGoBack: () => true, back() {}, replace() {}, push() {} }),
}))

let root: ReturnType<typeof createRoot>, container: HTMLElement
const session = (id: string): CliSessionRowT => ({
  session_id: id, code: id, source: 'claude', displayName: 'Claude', status: 'idle', stale: false, project: id, machine: null,
  last_summary: 'Ready', last_event_at: Date.now(), last_prompt_at: null, created_at: 1, pending: null,
})
function gate<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function delayedBackend() {
  const reply = gate<{ sayId: string | null }>()
  const say = vi.fn((_id: string, _text: string) => reply.promise)
  const backend: Backend = { ...makeDemoBackend({ lang: 'en' }), cliSessions: async () => [session('terminal-a'), session('terminal-b')], cliActivity: async () => [], cliSay: say }
  return { backend, say, reply }
}
const input = () => container.querySelector<HTMLTextAreaElement>('[data-testid="terminal-say-input"]')!
const sendButton = () => container.querySelector<HTMLButtonElement>('[data-testid="terminal-say-send"]')!
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function show(backend: Backend) {
  await act(() => root.render(withProviders(createElement(TerminalSession), { backend, lang: 'en' })))
  await flush()
}
async function type(value: string) {
  await act(() => { input().value = value; input().dispatchEvent(new Event('input', { bubbles: true })) })
}
async function send() { await act(() => sendButton().click()); await flush() }

beforeEach(() => {
  clearDrafts(); host.id = 'terminal-a'
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); container.remove(); clearDrafts() })

describe('terminal async send draft ownership', () => {
  it('keeps a newer draft editable while sending and clears only an unchanged submitted snapshot', async () => {
    const h = delayedBackend(); await show(h.backend); await type('  first message  '); await send()
    expect(h.say).toHaveBeenCalledExactlyOnceWith('terminal-a', 'first message')
    expect(sendButton().disabled).toBe(true)
    expect(input().readOnly).toBe(false)
    await type('a newer draft')
    await act(() => h.reply.resolve({ sayId: null })); await flush()
    expect(input().value).toBe('a newer draft')
    expect(sendButton().disabled).toBe(false)
  })

  it('clears the submitted text on success when it has not been edited', async () => {
    const h = delayedBackend(); await show(h.backend); await type('first message'); await send()
    await act(() => h.reply.resolve({ sayId: null })); await flush()
    expect(input().value).toBe('')
    expect(h.say).toHaveBeenCalledOnce()
  })

  it('treats editing and restoring the same text as a new draft', async () => {
    const h = delayedBackend(); await show(h.backend); await type('same words'); await send()
    await type('different draft'); await type('same words')
    await act(() => h.reply.resolve({ sayId: null })); await flush()
    expect(input().value).toBe('same words')
  })

  it('retains the submitted draft after an unsuccessful response', async () => {
    const h = delayedBackend(); await show(h.backend); await type('keep after failure'); await send()
    await act(() => h.reply.reject(new BackendError('timeout'))); await flush()
    expect(input().value).toBe('keep after failure')
  })

  it('does not apply an earlier terminal response after navigation to another session', async () => {
    const h = delayedBackend(); await show(h.backend); await type('first session'); await send()
    host.id = 'terminal-b'; await show(h.backend); await type('second session draft')
    await act(() => h.reply.resolve({ sayId: null })); await flush()
    expect(input().value).toBe('second session draft')
    expect(container.querySelector('[data-testid="terminal-detail-note"]')).toBeNull()
  })

  it('does not apply an earlier response after the connected backend changes', async () => {
    const previous = delayedBackend(); await show(previous.backend); await type('first computer'); await send()
    const current = delayedBackend(); await show(current.backend); await type('second computer draft')
    await act(() => previous.reply.resolve({ sayId: null })); await flush()
    expect(input().value).toBe('second computer draft')
    expect(container.querySelector('[data-testid="terminal-detail-note"]')).toBeNull()
  })

  it('ignores a completion invalidated before the new pairing is rendered', async () => {
    const h = delayedBackend(); await show(h.backend); await type('old scope'); await send()
    await type('new pairing draft'); setPairingScope('another-computer')
    await act(() => h.reply.resolve({ sayId: null })); await flush()
    expect(input().value).toBe('new pairing draft')
    expect(container.querySelector('[data-testid="terminal-detail-note"]')).toBeNull()
  })
})
