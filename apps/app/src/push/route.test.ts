import { describe, it, expect, vi } from 'vitest'
import { BackendError } from '../backend/types'
import { approvalView } from '../view/approval'
import { resolvePushRoute, hrefFor, pushOpenHref } from './route'
import { targetFromParams } from './target'

const ok = vi.fn(async () => ({}))

describe('resolvePushRoute —— 旧通知先定位事项、拉最新详情再展示(spec §3)', () => {
  it('批准 / 问题 ⇒ 批准页并钉住那条请求;没有 requestId ⇒ 批准页自己出选择列表', async () => {
    expect(await resolvePushRoute({ kind: 'permission', taskId: 'ab12cd34', requestId: 'perm-1' }, ok)).toEqual({ kind: 'approval', id: 'ab12cd34', request: 'perm-1' })
    expect(await resolvePushRoute({ kind: 'question', taskId: 'ab12cd34' }, ok)).toEqual({ kind: 'approval', id: 'ab12cd34' })
    expect(ok).toHaveBeenCalledWith('ab12cd34')
  })
  it('完成 / 失败 ⇒ 进展页', async () => {
    expect(await resolvePushRoute({ kind: 'task_done', taskId: 'ab12cd34' }, ok)).toEqual({ kind: 'matter', id: 'ab12cd34' })
    expect(await resolvePushRoute({ kind: 'task_failed', taskId: 'ab12cd34' }, ok)).toEqual({ kind: 'matter', id: 'ab12cd34' })
  })
  it('事情在电脑上已经不在(not_found)⇒ gone,回此刻', async () => {
    const r = await resolvePushRoute({ kind: 'permission', taskId: 'ab12cd34', requestId: 'p' }, async () => { throw new BackendError('not_found') })
    expect(r).toEqual({ kind: 'gone' })
    expect(hrefFor(r)).toBe('/')
  })
  it('旧通知对应的请求已处理 ⇒ 仍进批准页,而批准页拿最新详情算出的是「已处理」(none),不是可点的批准卡', async () => {
    const r = await resolvePushRoute({ kind: 'permission', taskId: 'ab12cd34', requestId: 'perm-1' }, ok)
    expect(r).toEqual({ kind: 'approval', id: 'ab12cd34', request: 'perm-1' })
    const fresh = { permissions: [{ id: 'perm-2', taskId: 'ab12cd34', tool: 'Bash', description: 'ls', createdAt: 2 }], questions: [], runId: 'run-1', task: null } as any
    expect(approvalView(fresh, {}, 'perm-1')).toEqual({ kind: 'none' })
    expect(approvalView({ ...fresh, permissions: [] }, {}, 'perm-1')).toEqual({ kind: 'none' })
  })
  it('离线 / 超时 / 拉详情一直不回 ⇒ 照样进目标页(那页显示离线提示与上次同步的内容)', async () => {
    expect(await resolvePushRoute({ kind: 'task_done', taskId: 'ab12cd34' }, async () => { throw new BackendError('offline') })).toEqual({ kind: 'matter', id: 'ab12cd34' })
    vi.useFakeTimers()
    const p = resolvePushRoute({ kind: 'task_done', taskId: 'ab12cd34' }, () => new Promise(() => {}), 5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toEqual({ kind: 'matter', id: 'ab12cd34' })
    vi.useRealTimers()
  })
  it('没目标 / 没 taskId(测试通知、解不开的占位)⇒ 回此刻,不发请求', async () => {
    const f = vi.fn(async () => ({}))
    expect(await resolvePushRoute(null, f)).toEqual({ kind: 'home' })
    expect(await resolvePushRoute({ kind: 'test' }, f)).toEqual({ kind: 'home' })
    expect(f).not.toHaveBeenCalled()
  })
  it('伪造深链 taskId=../../x ⇒ 清洗后没 taskId ⇒ 回此刻,不向奇怪的路径发请求', async () => {
    const f = vi.fn(async () => ({}))
    const t = targetFromParams(Object.fromEntries(new URLSearchParams('kind=permission&taskId=../../x&requestId=' + 'z'.repeat(9999))))
    const r = await resolvePushRoute(t, f)
    expect(r).toEqual({ kind: 'home' })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('href', () => {
  it('hrefFor', () => {
    expect(hrefFor({ kind: 'approval', id: 'ab12cd34', request: 'perm 1' })).toBe('/approval/ab12cd34?request=perm%201')
    expect(hrefFor({ kind: 'approval', id: 'ab12cd34' })).toBe('/approval/ab12cd34')
    expect(hrefFor({ kind: 'matter', id: 'ab12cd34' })).toBe('/matter/ab12cd34')
    expect(hrefFor({ kind: 'home' })).toBe('/')
    expect(hrefFor({ kind: 'gone' })).toBe('/')
  })
  it('pushOpenHref ↔ targetFromParams 往返', () => {
    const t = { kind: 'permission', taskId: 'ab12cd34', requestId: 'r:1.x' } as const
    const href = pushOpenHref(t)
    expect(href.startsWith('/push-open?')).toBe(true)
    expect(targetFromParams(Object.fromEntries(new URLSearchParams(href.split('?')[1])))).toEqual(t)
  })
})
