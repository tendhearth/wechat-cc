// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { BackendError, type Backend } from '../backend/types'
import Memory from '../app/memory'
import { withProviders } from '../state/providers.test-support'
import { cleanup, mount } from '../ui/native-motion.test-support'

vi.mock('react-native', async () => (await import('../ui/native-motion.test-support')).nativeBoundary())
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: (await import('../ui/native-motion.test-support')).View }))
vi.mock('expo-router', () => ({ useRouter: () => ({ canGoBack: () => true, back: vi.fn(), replace: vi.fn() }) }))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)

const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function screen(backend: Backend) {
  const ui = await mount(withProviders(createElement(Memory), { backend }))
  await flush()
  const click = async (id: string) => { await act(() => ui.byId(id).click()); await flush() }
  return { ...ui, click }
}

describe('memory correction and withdrawal recovery', () => {
  it('waits for correction success, then exposes the new withdrawn record and restores it without remounting', async () => {
    const backend = makeDemoBackend({ lang: 'zh-Hans' })
    const correct = backend.correctMemory
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    backend.correctMemory = async (id, verdict) => { await pending; await correct(id, verdict) }
    const ui = await screen(backend)
    expect(ui.byId('memory-retractions-toggle')).toBeNull()
    await ui.click('memory-item-a1b2c3')
    await ui.click('memory-fix-wrong')
    expect(ui.byId('memory-item-a1b2c3').textContent).toContain('回复喜欢直接')
    expect(ui.byId('memory-retractions-toggle')).toBeNull()
    expect((ui.byId('memory-fix-wrong') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { release(); await pending }); await flush()
    expect(ui.byId('memory-item-a1b2c3')).toBeNull()
    expect(ui.byId('memory-retractions-toggle')).not.toBeNull()
    await ui.click('memory-retractions-toggle')
    expect(ui.byId('memory-retraction-c:~1').textContent).toContain('回复喜欢直接')
    await ui.click('memory-restore-c:~1')
    expect(ui.byId('memory-item-a1b2c3').textContent).toContain('回复喜欢直接')
    expect(ui.byId('memory-restore-note').textContent).toContain('已经放回记忆')
  })

  it('keeps the original factual record and failure feedback when correction is rejected', async () => {
    const backend = makeDemoBackend({ lang: 'zh-Hans' })
    backend.correctMemory = async () => { throw new BackendError('offline') }
    const ui = await screen(backend)
    await ui.click('memory-item-a1b2c3')
    await ui.click('memory-fix-delete')
    expect(ui.byId('memory-item-a1b2c3').textContent).toContain('回复喜欢直接')
    expect(ui.byId('memory-retractions-toggle')).toBeNull()
    expect(ui.byId('memory-note').textContent).toContain('没改成')
    expect((ui.byId('memory-fix-delete') as HTMLButtonElement).disabled).toBe(false)
  })
})
