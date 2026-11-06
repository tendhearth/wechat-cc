import { describe, expect, it, vi } from 'vitest'
import { openSeenMatter } from './matter-seen.js'

describe('opening a matter from the pet', () => {
  it('posts seen for the exact matter after its window opens', async () => {
    let finish!: () => void
    const open = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const call = vi.fn(async () => ({ ok: true }))
    const target = { page: 'workbench', taskId: 'deadbeef' }
    const pending = openSeenMatter(target, open, call)
    expect(open).toHaveBeenCalledWith(target)
    expect(call).not.toHaveBeenCalled()
    finish(); await pending
    expect(call).toHaveBeenCalledWith('POST', '/v1/matter/seen', { id: 'deadbeef' })
  })

  it('does not acknowledge a failed open or the conversation destination; an old daemon cannot prevent opening', async () => {
    const call = vi.fn(async () => { throw Error('old daemon') })
    await expect(openSeenMatter({ page: 'workbench', taskId: 'deadbeef' }, async () => { throw Error('cannot open') }, call)).rejects.toThrow('cannot open')
    expect(call).not.toHaveBeenCalled()
    await openSeenMatter({ page: 'converse' }, async () => {}, call)
    expect(call).not.toHaveBeenCalled()
    await expect(openSeenMatter({ page: 'workbench', taskId: 'deadbeef' }, async () => {}, call)).resolves.toBeUndefined()
    expect(call).toHaveBeenCalledTimes(1)
  })
})
