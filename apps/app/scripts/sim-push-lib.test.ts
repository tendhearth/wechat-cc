import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { derivePushKey, openPush, PushPlaintext } from '@wechat-cc/protocol'
import { buildSimPush, devToken } from './sim-push-lib'
import { isDevPushToken } from '../src/push/key-store'

const NOW = 1_700_000_000_000
const base = { kind: 'permission' as const, taskId: 'a1b2c3d4', requestId: 'perm-demo-1', body: '整理作品集:npm i sharp', now: NOW }

describe('sim-push', () => {
  it('devToken:合成的开发令牌,过 isDevPushToken,不是真设备令牌的形状', () => {
    expect(isDevPushToken(devToken('sim-push'))).toBe(true)
    expect(devToken('a')).not.toBe(devToken('b'))
  })
  it('ok:形状与中继发给 APNs 的一致(占位 alert + mutable-content + wcc),用开发令牌的推送密钥能解开', () => {
    const tok = devToken('sim-push')
    const p = buildSimPush({ ...base, token: tok, mode: 'ok' })
    expect(p.aps).toEqual({ alert: { title: 'CC', body: 'CC 有新动态' }, 'mutable-content': 1, sound: 'default' })
    const plain = PushPlaintext.parse(openPush(derivePushKey(tok), p.wcc, NOW))
    expect(plain).toMatchObject({ kind: 'permission', taskId: 'a1b2c3d4', requestId: 'perm-demo-1' })
    expect(readFileSync(new URL('../../relay/src/push-apns.ts', import.meta.url), 'utf8')).toContain("'mutable-content': 1")
  })
  it('stale / tamper / wrong-key 各自解不开', () => {
    const tok = devToken('sim-push')
    const key = derivePushKey(tok)
    expect(() => openPush(key, buildSimPush({ ...base, token: tok, mode: 'stale' }).wcc, NOW)).toThrow('stale')
    expect(() => openPush(key, buildSimPush({ ...base, token: tok, mode: 'tamper' }).wcc, NOW)).toThrow()
    expect(() => openPush(key, buildSimPush({ ...base, token: tok, mode: 'wrong-key' }).wcc, NOW)).toThrow()
  })
})
