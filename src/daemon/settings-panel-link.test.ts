/**
 * linkUrl 指向中继上的壳页:v2 中继(`…/v2/phone`)与老中继(`…/tunnel/phone`)都要去掉路径尾巴。
 * lanIp 被 mock 成固定地址 —— CI 机器可能没有私网网卡,linkUrl 会直接回 null。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../lib/local-address', async (orig) => ({ ...(await orig<typeof import('../lib/local-address')>()), lanIp: () => '192.168.1.2' }))
const { makeSettingsPanel } = await import('./settings-panel')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'panel-link-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function mk(remote: { id: string; relay: string }) {
  return makeSettingsPanel({
    stateDir: dir, ownerChatId: () => 'owner@im.wechat',
    chatPrefs: { get: () => ({}), set: (_c, p) => p },
    getUserName: () => null, setUserName: async () => {}, log: () => {},
    remoteInfo: () => remote,
  })
}

describe('settings panel linkUrl', () => {
  it('v2 中继 ⇒ https://relay.tendhearth.com/pset/#id=…', async () => {
    const p = mk({ id: 'rabc', relay: 'wss://relay.tendhearth.com/v2/phone' })
    try { expect(await p.linkUrl()).toMatch(/^https:\/\/relay\.tendhearth\.com\/pset\/#id=rabc&t=/) } finally { p.stop() }
  })
  it('老中继照旧 ⇒ https://cc.tendhearth.com/pset/#id=…', async () => {
    const p = mk({ id: 'tabc', relay: 'wss://cc.tendhearth.com/tunnel/phone' })
    try { expect(await p.linkUrl()).toMatch(/^https:\/\/cc\.tendhearth\.com\/pset\/#id=tabc&t=/) } finally { p.stop() }
  })
})
