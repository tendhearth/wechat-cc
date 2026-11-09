import { expect, it } from 'vitest'
import { startRealShapedDaemon } from './real-shaped'
import { dependencyBackground } from '../../adapters/git/worktree-dependency-background'

it('real daemon shutdown cancels and drains its active dependency installer before releasing state', async () => {
  const daemon = await startRealShapedDaemon()
  try {
    expect(await daemon.moduleProblems()).toEqual([])
    const worker = dependencyBackground(daemon.stateDir)
    let started!: () => void, cleaned = false, queuedRan = false
    const active = new Promise<void>(resolve => { started = resolve })
    worker.enqueue('offline-active-install', async signal => {
      started()
      try { await new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      }) } finally { cleaned = true }
    })
    worker.enqueue('offline-queued-install', async () => { queuedRan = true })
    await active
    await daemon.stop()
    expect(worker.stopped).toBe(true)
    expect(cleaned).toBe(true)
    expect(queuedRan).toBe(false)
  } finally { await dependencyBackground(daemon.stateDir).stop(); await daemon.stop() }
})
