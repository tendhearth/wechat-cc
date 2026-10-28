// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { BackendError, type Backend } from '../backend/types'
import Memory from '../app/memory'
import { withProviders, type TestCtx } from '../state/providers.test-support'
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
    expect(ui.byId('memory-note').textContent).toContain('拿掉了')
    await ui.click('memory-retractions-toggle')
    expect(ui.byId('memory-retraction-c:~1').textContent).toContain('回复喜欢直接')
    const restore = backend.restoreMemory
    let releaseRestore!: () => void
    const restoring = new Promise<void>(resolve => { releaseRestore = resolve })
    backend.restoreMemory = async key => { await restoring; return restore(key) }
    await ui.click('memory-restore-c:~1')
    expect(ui.byId('memory-note')).toBeNull()
    expect(ui.byId('memory-restore-note')).toBeNull()
    expect((ui.byId('memory-restore-c:~1') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { releaseRestore(); await restoring }); await flush()
    expect(ui.byId('memory-item-a1b2c3').textContent).toContain('回复喜欢直接')
    expect(ui.byId('memory-restore-note').textContent).toContain('已经放回记忆')
    expect(ui.byId('memory-note')).toBeNull()
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

  it('revalidates both lists after success even when earlier factual and initial withdrawn reads are still in flight', async () => {
    const backend = makeDemoBackend({ lang: 'zh-Hans' })
    const memory = backend.memory, retractions = backend.memoryRetractions
    const oldFacts = await memory(), oldWithdrawn = await retractions()
    let releaseFacts!: (value: typeof oldFacts) => void, releaseWithdrawn!: (value: typeof oldWithdrawn) => void
    const pendingFacts = new Promise<typeof oldFacts>(resolve => { releaseFacts = resolve })
    const pendingWithdrawn = new Promise<typeof oldWithdrawn>(resolve => { releaseWithdrawn = resolve })
    let factReads = 0, withdrawnReads = 0, ctx!: TestCtx
    backend.memory = async () => ++factReads === 2 ? pendingFacts : memory()
    backend.memoryRetractions = async () => ++withdrawnReads === 1 ? pendingWithdrawn : retractions()
    const ui = await mount(withProviders(createElement(Memory), { backend, onCtx: value => { ctx = value } })); await flush()
    // The existing factual row remains usable during a background read; the first withdrawn read has not returned yet.
    await act(() => { void ctx.store.query('memory', () => backend.memory()).refresh() }); await flush()
    await act(() => ui.byId('memory-item-a1b2c3').click()); await flush()
    await act(() => ui.byId('memory-fix-wrong').click()); await flush()
    await act(async () => {
      releaseFacts(oldFacts); releaseWithdrawn(oldWithdrawn)
      await Promise.all([pendingFacts, pendingWithdrawn])
    }); await flush()
    expect(ui.byId('memory-item-a1b2c3')).toBeNull()
    expect(ui.byId('memory-retractions-toggle')).not.toBeNull()
    await act(() => ui.byId('memory-retractions-toggle').click()); await flush()
    expect(ui.byId('memory-retraction-c:~1').textContent).toContain('回复喜欢直接')
  })

  it('reads restored facts after success instead of reusing an initial pre-restore snapshot', async () => {
    const backend = makeDemoBackend({ lang: 'zh-Hans' })
    await backend.correctMemory('a1b2c3', 'wrong')
    const memory = backend.memory, oldFacts = await memory()
    let release!: (value: typeof oldFacts) => void, reads = 0
    const pending = new Promise<typeof oldFacts>(resolve => { release = resolve })
    backend.memory = async () => ++reads === 1 ? pending : memory()
    const ui = await screen(backend)
    await ui.click('memory-retractions-toggle')
    await ui.click('memory-restore-c:~1')
    expect(ui.byId('memory-restore-note').textContent).toContain('已经放回记忆')
    await act(async () => { release(oldFacts); await pending }); await flush()
    expect(ui.byId('memory-item-a1b2c3').textContent).toContain('回复喜欢直接')
    expect(ui.byId('memory-retractions-toggle')).toBeNull()
  })

  it.each(['success', 'failure'])('clears restored feedback while the next correction is pending and keeps only its %s result', async outcome => {
    const backend = makeDemoBackend({ lang: 'zh-Hans' })
    const correct = backend.correctMemory
    await correct('a1b2c3', 'wrong')
    const ui = await screen(backend)
    await ui.click('memory-retractions-toggle')
    await ui.click('memory-restore-c:~1')
    expect(ui.byId('memory-restore-note').textContent).toContain('已经放回记忆')
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    backend.correctMemory = async (id, verdict) => {
      await pending
      if (outcome === 'failure') throw new BackendError('offline')
      await correct(id, verdict)
    }
    await ui.click('memory-item-a1b2c3')
    await ui.click('memory-fix-delete')
    expect(ui.byId('memory-restore-note')).toBeNull()
    expect(ui.byId('memory-note')).toBeNull()
    expect(ui.byId('memory-item-a1b2c3').textContent).toContain('回复喜欢直接')
    expect((ui.byId('memory-fix-delete') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { release(); await pending }); await flush()
    expect(ui.byId('memory-restore-note')).toBeNull()
    expect(ui.byId('memory-note').textContent).toContain(outcome === 'success' ? '拿掉了' : '没改成')
    if (outcome === 'success') expect(ui.byId('memory-item-a1b2c3')).toBeNull()
    else expect(ui.byId('memory-item-a1b2c3').textContent).toContain('回复喜欢直接')
  })
})
