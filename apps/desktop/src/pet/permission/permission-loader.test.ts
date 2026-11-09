import { expect, it, vi } from 'vitest'
import { createPermissionLoader } from './permission-loader.js'

const summary = { hash: 'one', prompt: 'safe metadata', since: 's', expires_at: 'e' }
const detail = { ...summary, prompt: 'authorized full input', scripts: [{ path: 'check.py', content: 'private source' }] }
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

it('P2-5: never shows an approvable card from trusted metadata; waits for authorized detail and deduplicates reads', async () => {
  let release!: (value: typeof detail[]) => void
  const read = vi.fn(() => new Promise<typeof detail[]>(resolve => { release = resolve })), show = vi.fn(), hide = vi.fn()
  const loader = createPermissionLoader({ read, show, hide })
  loader.update(summary, 2); loader.update(summary, 3)
  expect(read).toHaveBeenCalledTimes(1); expect(show).not.toHaveBeenCalled()
  release([detail]); await tick()
  expect(show).toHaveBeenCalledWith(detail, 3)
  loader.update(summary, 1)
  expect(read).toHaveBeenCalledTimes(1); expect(show).toHaveBeenLastCalledWith(detail, 1)
  loader.update(null, 0); expect(hide).toHaveBeenCalled()
})

it('P2-5: errors, missing hashes and late detail from an old card never enable a blind approval', async () => {
  let release!: (value: typeof detail[]) => void
  const read = vi.fn<() => Promise<typeof detail[]>>().mockRejectedValueOnce(Error('403')).mockResolvedValueOnce([])
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValueOnce([{ ...detail, hash: 'two' }])
  const show = vi.fn(), hide = vi.fn(), loader = createPermissionLoader({ read, show, hide })
  loader.update(summary, 1); await tick(); expect(show).not.toHaveBeenCalled()
  loader.update(summary, 1); await tick(); expect(show).not.toHaveBeenCalled()
  loader.update(summary, 1)
  loader.update({ ...summary, hash: 'two' }, 1); await tick()
  expect(show).toHaveBeenCalledTimes(1); expect(show.mock.calls[0]![0].hash).toBe('two')
  release([detail]); await tick()
  expect(show).toHaveBeenCalledTimes(1)
  loader.update(null, 0); expect(hide).toHaveBeenCalled()
})
