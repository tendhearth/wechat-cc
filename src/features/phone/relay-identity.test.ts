import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyRelayLogin, RELAY_ID_RE } from '@wechat-cc/protocol'
import { loadOrCreateRelayIdentity } from './relay-identity'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'relay-ident-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('relay-identity', () => {
  it('首次生成:id 形状对、文件 0600、再读是同一个 id', () => {
    const a = loadOrCreateRelayIdentity(dir)
    expect(a.id).toMatch(RELAY_ID_RE)
    if (process.platform !== 'win32') expect(statSync(join(dir, 'relay-identity.json')).mode & 0o777).toBe(0o600)
    expect(loadOrCreateRelayIdentity(dir).id).toBe(a.id)
  })
  it('签名能被中继验过', () => {
    const a = loadOrCreateRelayIdentity(dir)
    const { pub, sig } = a.sign('chal')
    expect(verifyRelayLogin(a.id, 'chal', pub, sig)).toBe(true)
  })
  it('文件损坏 ⇒ 抛,绝不悄悄换一台「新电脑」', () => {
    writeFileSync(join(dir, 'relay-identity.json'), '{"v":1,"seed":"短"}')
    expect(() => loadOrCreateRelayIdentity(dir)).toThrow('relay_identity_corrupt')
    expect(readFileSync(join(dir, 'relay-identity.json'), 'utf8')).toBe('{"v":1,"seed":"短"}')
  })
})
