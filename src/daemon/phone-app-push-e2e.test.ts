/**
 * daemon 真 makePhonePush 封的推送 ↔ 手机 app 从设备令牌推出、存进共享钥匙串的推送密钥:两边对得上(spec §7、§9.3)。
 * 不起中继:send 直接收下 daemon 要发给房间的控制消息。
 * 手机这头只用 apps/app/src/push/key-store.ts(纯 TS)与内存钥匙串 —— 读回的正是扩展 / 消息服务会读的那条记录。
 * 解开后的明文再走点通知的目标解析与路由决定(apps/app/src/push/{target,route}.ts,纯 TS)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { b64uDecode, openPush, PushPlaintext, type SealedPush } from '@wechat-cc/protocol'
import { makePhonePush } from './phone-push'
import { resolvePushRoute, hrefFor, pushOpenHref } from '../../apps/app/src/push/route'
import { targetFromParams, targetFromPlaintext } from '../../apps/app/src/push/target'
import { makePushKeyStore, PUSH_KEY_ITEM, PUSH_KEY_SERVICE } from '../../apps/app/src/push/key-store'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function memKeychain() {
  const m = new Map<string, string>()
  const k = (key: string, o?: { keychainService?: string }) => `${o?.keychainService ?? 'app'}/${key}`
  return {
    m,
    ss: {
      getItemAsync: async (key: string, o?: { keychainService?: string }) => m.get(k(key, o)) ?? null,
      setItemAsync: async (key: string, v: string, o?: { keychainService?: string }) => { m.set(k(key, o), v) },
      deleteItemAsync: async (key: string, o?: { keychainService?: string }) => { m.delete(k(key, o)) },
    },
  }
}

describe('daemon 推送 → app 解开', () => {
  it('permission 推送:扩展读到的推送密钥记录能解开 daemon 封的推送,明文过 PushPlaintext;别的设备令牌推出的密钥解不开', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcc-push-e2e-'))
    dirs.push(dir)
    const token = 'd' + '0f'.repeat(24)
    const sent: Array<Record<string, unknown>> = []
    const push = makePhonePush({ stateDir: dir, send: m => { sent.push(m as Record<string, unknown>); return true }, deviceToken: () => token, deviceIds: () => ['ab12cd34'], log: () => {} })
    expect(push.register('ab12cd34', 'apns_sandbox', 'a1'.repeat(32))).toBe(true)
    expect(push.notify('ab12cd34', { kind: 'permission', title: '需要你批准', body: '整理作品集:npm i sharp', taskId: 'ab12cd34', requestId: 'perm-1' })).toBe(true)
    const msg = sent.find(m => 'push' in m) as { push: { sealed: SealedPush; collapseId: string } } | undefined
    expect(msg).toBeDefined()
    expect(msg!.push.collapseId).toBe('ab12cd34')

    // app 这头:配对后 ensure 把记录写进共享钥匙串;扩展只读这一条
    const { m, ss } = memKeychain()
    await makePushKeyStore(ss, { shared: { keychainService: PUSH_KEY_SERVICE }, local: {} }).ensure(token, 'zh-Hans')
    const rec = JSON.parse(m.get(`${PUSH_KEY_SERVICE}/${PUSH_KEY_ITEM}`)!) as { v: number; key: string; lang: string | null }
    expect(rec).toMatchObject({ v: 1, lang: 'zh-Hans' })
    expect(JSON.stringify(rec)).not.toContain(token)

    const plain = PushPlaintext.parse(openPush(b64uDecode(rec.key), msg!.push.sealed, Date.now()))
    expect(plain).toMatchObject({ kind: 'permission', title: '需要你批准', taskId: 'ab12cd34', requestId: 'perm-1' })

    // 点开:明文 → 目标 → 先拉详情 → 批准页并钉住那条请求;安卓走 push-open 深链往返
    const target = targetFromPlaintext(plain)
    expect(target).toEqual({ kind: 'permission', taskId: 'ab12cd34', requestId: 'perm-1' })
    const fetched: string[] = []
    const route = await resolvePushRoute(target, async id => { fetched.push(id); return {} })
    expect(route).toEqual({ kind: 'approval', id: 'ab12cd34', request: 'perm-1' })
    expect(hrefFor(route)).toBe('/approval/ab12cd34?request=perm-1')
    expect(fetched).toEqual(['ab12cd34'])
    expect(targetFromParams(Object.fromEntries(new URLSearchParams(pushOpenHref(target!).split('?')[1])))).toEqual(target)

    const { m: m2, ss: ss2 } = memKeychain()
    await makePushKeyStore(ss2, { shared: { keychainService: PUSH_KEY_SERVICE }, local: {} }).ensure('d' + 'ee'.repeat(24), null)
    const other = JSON.parse(m2.get(`${PUSH_KEY_SERVICE}/${PUSH_KEY_ITEM}`)!) as { key: string }
    expect(() => openPush(b64uDecode(other.key), msg!.push.sealed, Date.now())).toThrow()
  })

  it('伪造的 push-open 深链:坏 taskId / 巨长 requestId 被丢,回此刻,不发请求', async () => {
    const t = targetFromParams(Object.fromEntries(new URLSearchParams('kind=permission&taskId=../../x&requestId=' + 'q'.repeat(4000))))
    let calls = 0
    expect(await resolvePushRoute(t, async () => { calls++ })).toEqual({ kind: 'home' })
    expect(calls).toBe(0)
  })
})
