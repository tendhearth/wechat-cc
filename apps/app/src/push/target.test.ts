import { describe, it, expect } from 'vitest'
import { derivePushKey, sealPush } from '@wechat-cc/protocol'
import { cleanTarget, targetFromParams, targetFromNotification, targetFromPlaintext } from './target'

const T = { kind: 'permission', taskId: 'ab12cd34', requestId: 'perm-1' } as const

describe('cleanTarget —— 深链参数谁都能伪造,形状不对的一律丢', () => {
  it('合法的原样保留', () => { expect(cleanTarget(T)).toEqual(T) })
  it('未知 kind / 不是对象 ⇒ null', () => {
    expect(cleanTarget({ ...T, kind: 'approval_needed' })).toBeNull()
    expect(cleanTarget(null)).toBeNull()
    expect(cleanTarget('permission')).toBeNull()
  })
  it('taskId 不是 8 位小写 hex ⇒ 丢掉 taskId(之后回此刻);requestId 不合形状 ⇒ 丢掉 requestId', () => {
    expect(cleanTarget({ ...T, taskId: '../../x' })).toEqual({ kind: 'permission', requestId: 'perm-1' })
    expect(cleanTarget({ ...T, taskId: 'AB12CD34' })).toEqual({ kind: 'permission', requestId: 'perm-1' })
    expect(cleanTarget({ ...T, requestId: 'x'.repeat(129) })).toEqual({ kind: 'permission', taskId: 'ab12cd34' })
    expect(cleanTarget({ ...T, requestId: 'a/b' })).toEqual({ kind: 'permission', taskId: 'ab12cd34' })
    expect(cleanTarget({ ...T, requestId: 7 })).toEqual({ kind: 'permission', taskId: 'ab12cd34' })
  })
})

describe('targetFromParams(安卓深链 / 中转页参数)', () => {
  it('取数组的第一个;缺 kind ⇒ null', () => {
    expect(targetFromParams({ kind: ['permission', 'x'], taskId: 'ab12cd34', requestId: 'perm-1' })).toEqual(T)
    expect(targetFromParams({ taskId: 'ab12cd34' })).toBeNull()
  })
  it('伪造深链 push-open?taskId=../../x&requestId=<巨长> ⇒ 两个参数都丢,只剩 kind', () => {
    const q = new URLSearchParams('kind=permission&taskId=../../x&requestId=' + 'y'.repeat(5000))
    expect(targetFromParams(Object.fromEntries(q))).toEqual({ kind: 'permission' })
  })
  it('安卓深链把空格编成 +:URLSearchParams 解成空格 ⇒ 不合形状,丢掉', () => {
    const q = new URLSearchParams('kind=permission&taskId=ab12cd34&requestId=perm+1')
    expect(targetFromParams(Object.fromEntries(q))).toEqual({ kind: 'permission', taskId: 'ab12cd34' })
  })
})

describe('targetFromNotification(iOS:expo-notifications 的通知对象)', () => {
  const n = (where: 'data' | 'payload', extra: Record<string, unknown>) => ({
    date: 1_700_000_000_000,
    request: { identifier: 'x', content: { title: 'Needs your approval', body: 'b', data: where === 'data' ? extra : {} }, trigger: { type: 'push', payload: where === 'payload' ? extra : {} } },
  })
  it('扩展写的 tendhearth 路由:content.data 或 trigger.payload 里都认', () => {
    expect(targetFromNotification(n('data', { tendhearth: T }))).toEqual(T)
    expect(targetFromNotification(n('payload', { tendhearth: T }))).toEqual(T)
  })
  it('tendhearth 路由里的伪造字段同样被清洗', () => {
    expect(targetFromNotification(n('data', { tendhearth: { ...T, taskId: '../../x' } }))).toEqual({ kind: 'permission', requestId: 'perm-1' })
  })
  it('扩展没解开(只有 wcc 密文)⇒ 有兜底密钥就在 app 里解;时间用通知送达时刻;wcc 是字符串也认', () => {
    const key = derivePushKey('d' + '0f'.repeat(24))
    const now = 1_700_000_000_000
    const sealed = sealPush(key, { ts: now - 1000, kind: 'question', title: 't', body: 'b', taskId: 'ab12cd34', requestId: 'q-1' })
    expect(targetFromNotification(n('payload', { wcc: sealed }), { key, now })).toEqual({ kind: 'question', taskId: 'ab12cd34', requestId: 'q-1' })
    expect(targetFromNotification(n('data', { wcc: JSON.stringify(sealed) }), { key, now })).toEqual({ kind: 'question', taskId: 'ab12cd34', requestId: 'q-1' })
    expect(targetFromNotification(n('payload', { wcc: sealed }))).toBeNull()
    expect(targetFromNotification(n('payload', { wcc: sealed }), { key: derivePushKey('other'), now })).toBeNull()
    expect(targetFromNotification(n('payload', { wcc: sealed }), { key, now: now + 2 * 3_600_000 })).toBeNull()
  })
  it('tendhearth 存在但畸形 ⇒ 落到 wcc 兜底而不是 null', () => {
    const key = derivePushKey('d' + '0f'.repeat(24))
    const now = 1_700_000_000_000
    const sealed = sealPush(key, { ts: now, kind: 'question', title: 't', body: 'b', taskId: 'ab12cd34' })
    expect(targetFromNotification(n('data', { tendhearth: 'junk', wcc: sealed }), { key, now })).toEqual({ kind: 'question', taskId: 'ab12cd34' })
    expect(targetFromNotification(n('data', { tendhearth: 'junk', wcc: sealed }))).toBeNull()
  })
  it('什么都没有 / 不是对象 ⇒ null', () => {
    expect(targetFromNotification(n('data', {}))).toBeNull()
    expect(targetFromNotification(undefined)).toBeNull()
  })
  it('targetFromPlaintext:只取 kind / taskId / requestId', () => {
    expect(targetFromPlaintext({ ts: 1, kind: 'task_done', title: 't', body: 'b', taskId: 'ab12cd34' })).toEqual({ kind: 'task_done', taskId: 'ab12cd34' })
  })
})
