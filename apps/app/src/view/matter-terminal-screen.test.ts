// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import type { Backend, CliSessionRowT } from '../backend/types'
import Matter from '../app/matter/[id]/index'
import { withProviders } from '../state/providers.test-support'
import { cleanup, mount } from '../ui/native-motion.test-support'

const route = vi.hoisted(() => ({ id: 'a1b2c3d4' }))
vi.mock('react-native', async () => {
  const { forwardRef } = await import('react')
  const native = (await import('../ui/native-motion.test-support')).nativeBoundary()
  const TextInput = forwardRef<any, any>(({ value, onChangeText, testID }: any, ref) => createElement('textarea', {
    ref, value, 'data-testid': testID, onInput: (event: any) => onChangeText(event.currentTarget.value),
  }))
  return { ...native, ScrollView: native.View, KeyboardAvoidingView: native.View, TextInput, ActivityIndicator: () => null, Linking: { openURL: vi.fn() } }
})
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaProvider: ({ children }: any) => children, SafeAreaView: (await import('../ui/native-motion.test-support')).View }))
vi.mock('expo-router', async () => ({
  ...await (await import('../ui/native-motion.test-support')).routerBoundary(),
  useLocalSearchParams: () => ({ id: route.id }),
  useRouter: () => ({ canGoBack: () => true, back() {}, replace() {}, push() {} }), Redirect: () => null,
}))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

/** 一件 kind='terminal' 的事(M4c):同一个详情页 /matter/<id>,按 kind 画终端那一份 —— 会话 id 从 cli 绑定来。 */
describe('终端会话的那件事 → 终端详情', () => {
  it('kind=terminal ⇒ 画终端详情(状态 / 看着它跑 / 说一句,按绑定的会话 id 拉);别的种类照旧', async () => {
    const demo = makeDemoBackend({ lang: 'en' })
    const base = await demo.matter('a1b2c3d4', 'en')
    const row: CliSessionRowT = {
      session_id: 'sess-42', code: 'sess-4', source: 'claude', displayName: 'Claude', status: 'idle', stale: false, project: 'blog', machine: null,
      last_summary: 'Ready', last_event_at: Date.now(), last_prompt_at: null, created_at: 1, pending: null, matter_id: 'feedf00d',
    }
    const activity = vi.fn(async () => [{ kind: 'step' as const, text: '运行 npm test', at: null }])
    const backend: Backend = {
      ...demo,
      matter: async (id, l) => (id === 'feedf00d'
        ? { ...base, matter: { ...base.matter, id, kind: 'terminal', title: 'blog' }, bindings: [{ matterId: id, surface: 'cli', surfaceKey: 'sess-42', lastSeenAt: 1 }] }
        : demo.matter(id, l)),
      cliSessions: async () => [row],
      cliActivity: activity,
    }
    route.id = 'feedf00d'
    const ui = await mount(withProviders(createElement(Matter), { backend, lang: 'en' }))
    await flush(); await flush()
    expect(ui.byId('terminal-detail-status')).not.toBeNull()
    expect(ui.byId('terminal-say-input')).not.toBeNull()
    expect(activity).toHaveBeenCalledWith('sess-42')
  })
})
