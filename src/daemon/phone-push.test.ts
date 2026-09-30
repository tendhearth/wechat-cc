import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { derivePushKey, openPush } from '@wechat-cc/protocol'
import { makePhonePush } from './phone-push'

const APNS = 'ab'.repeat(32)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'phone-push-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function setup(over: Partial<Parameters<typeof makePhonePush>[0]> = {}) {
  const sent: any[] = []
  const onChange = vi.fn()
  const push = makePhonePush({
    stateDir: dir, send: (m) => { sent.push(m); return true },
    deviceToken: (id) => ({ dev1: 'dtok-1', dev2: 'dtok-2' } as Record<string, string>)[id] ?? null,
    deviceIds: () => ['dev1', 'dev2'], onChange, now: () => 1_700_000_000_000, log: () => {},
    ...over,
  })
  return { push, sent, onChange }
}

describe('phone-push', () => {
  it('登记:校验 token、落盘 0600、发 push_reg、触发 onChange', () => {
    const { push, sent, onChange } = setup()
    expect(push.register('dev1', 'apns', 'zz')).toBe(false)
    expect(push.register('dev1', 'apns', APNS)).toBe(true)
    expect(sent).toContainEqual({ push_reg: { device: 'dev1', platform: 'apns', token: APNS } })
    expect(JSON.parse(readFileSync(join(dir, 'phone-push.json'), 'utf8')).dev1.token).toBe(APNS)
    expect(push.registered()).toEqual(['dev1'])
    expect(onChange).toHaveBeenCalled()
  })

  it('notify:用该设备的推送密钥封装,手机能解开;collapseId 按任务;超长标题正文被截', () => {
    const { push, sent } = setup()
    push.register('dev1', 'apns', APNS)
    expect(push.notify('dev1', { kind: 'permission', title: '标'.repeat(100), body: '正'.repeat(1000), taskId: 'ab12cd34' })).toBe(true)
    const m = sent.at(-1).push
    expect(m.device).toBe('dev1')
    expect(m.collapseId).toBe('ab12cd34')
    const pt = openPush(derivePushKey('dtok-1'), m.sealed, 1_700_000_000_000)
    expect(pt).toMatchObject({ kind: 'permission', taskId: 'ab12cd34' })
    expect([...(pt.title as string)].length).toBe(60)
    expect([...(pt.body as string)].length).toBe(300)
    expect(JSON.stringify(m.sealed).length).toBeLessThan(3500)
  })

  it('notify 没登记 / 设备令牌没了 ⇒ false(后者顺手删登记)', () => {
    const { push } = setup({ deviceToken: () => null })
    expect(push.notify('dev1', { kind: 'test', title: 't', body: 'b' })).toBe(false)
    push.register('dev1', 'apns', APNS)
    expect(push.notify('dev1', { kind: 'test', title: 't', body: 'b' })).toBe(false)
    expect(push.registered()).toEqual([])
  })

  it('test():按 ref 对上各自的结果;连发两条不串', async () => {
    const { push, sent } = setup()
    push.register('dev1', 'apns', APNS)
    const a = push.test('dev1'), b = push.test('dev1')
    const [ra, rb] = sent.filter(m => m.push).map(m => m.push.ref)
    push.onControl({ push_result: { device: 'dev1', ok: false, code: 'BadDeviceToken', ref: rb } })
    push.onControl({ push_result: { device: 'dev1', ok: true, code: 'ok', ref: ra } })
    expect(await a).toEqual({ ok: true, code: 'ok' })
    expect(await b).toEqual({ ok: false, code: 'BadDeviceToken' })
  })

  it('test():超时 ⇒ timeout;中继没连上 ⇒ relay_offline;没登记 ⇒ not_registered', async () => {
    vi.useFakeTimers()
    try {
      const { push } = setup({ resultTimeoutMs: 1000 })
      expect(await push.test('dev1')).toEqual({ ok: false, code: 'not_registered' })
      push.register('dev1', 'apns', APNS)
      const p = push.test('dev1')
      await vi.advanceTimersByTimeAsync(1000)
      expect(await p).toEqual({ ok: false, code: 'timeout' })
      const off = setup({ send: () => false }).push
      off.register('dev2', 'fcm', 'f'.repeat(30))
      expect(await off.test('dev2')).toEqual({ ok: false, code: 'relay_offline' })
    } finally { vi.useRealTimers() }
  })

  it('push_invalid ⇒ 删本地登记,不回发 unreg', () => {
    const { push, sent, onChange } = setup()
    push.register('dev1', 'apns', APNS)
    const before = sent.length
    push.onControl({ push_invalid: { device: 'dev1' } })
    expect(push.registered()).toEqual([])
    expect(sent.length).toBe(before)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('resync:修剪已撤销的设备(发 unreg),其余重发 push_reg', () => {
    const { push, sent } = setup({ deviceIds: () => ['dev2'] })
    push.register('dev1', 'apns', APNS)
    push.register('dev2', 'fcm', 'f'.repeat(30))
    sent.length = 0
    push.resync()
    expect(sent).toEqual([
      { push_unreg: { device: 'dev1' } },
      { push_reg: { device: 'dev2', platform: 'fcm', token: 'f'.repeat(30) } },
    ])
    expect(push.registered()).toEqual(['dev2'])
  })

  it('unregister / forgetAll 发 push_unreg;文件跟着清', () => {
    const { push, sent } = setup()
    push.register('dev1', 'apns', APNS)
    push.register('dev2', 'fcm', 'f'.repeat(30))
    push.unregister('dev1')
    expect(sent).toContainEqual({ push_unreg: { device: 'dev1' } })
    push.forgetAll()
    expect(sent).toContainEqual({ push_unreg: { device: 'dev2' } })
    expect(push.registered()).toEqual([])
    expect(existsSync(join(dir, 'phone-push.json'))).toBe(true)
  })
})
