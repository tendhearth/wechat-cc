import { describe, it, expect, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultBxExec, findBx, parseBxStatus, readBxStatus, type BxExec } from './bx'

// 真机 `bx status --json`(v0.4.28,2026-10-02)里判据用到的那部分形状。
const PROTECTED = JSON.stringify({
  server: '203.0.113.9', tunnel_healthy: true, mode: 'global', udp_mode: 'proxy',
  core_available: true, desired: 'on', protection_state: 'protected', dns_managed: true,
  observed: { tunnel_healthy: 'true', capture_ok: 'true' },
})

const ok = (stdout: string): BxExec => async () => ({ stdout, stderr: '', exitCode: 0 })

describe('parseBxStatus', () => {
  it('protected + tunnel healthy → safe', () => {
    const v = parseBxStatus(PROTECTED)
    expect(v).toEqual({ safe: true, protection: 'protected', tunnelHealthy: true, detail: 'bx 保护中' })
  })

  it('protected but tunnel unhealthy (degraded) → unsafe', () => {
    const v = parseBxStatus(JSON.stringify({ protection_state: 'protected', tunnel_healthy: false }))
    expect(v.safe).toBe(false)
    expect(v.detail).toContain('tunnel_healthy=false')
  })

  it.each(['off', 'starting', 'recovering', 'blocked', 'needs_attention', 'something_new'])('protection_state=%s → unsafe', (s) => {
    const v = parseBxStatus(JSON.stringify({ protection_state: s, tunnel_healthy: true }))
    expect(v.safe).toBe(false)
    expect(v.protection).toBe(s)
  })

  it('missing fields / wrong types → unsafe (fail closed)', () => {
    expect(parseBxStatus(JSON.stringify({ tunnel_healthy: true })).safe).toBe(false)
    expect(parseBxStatus(JSON.stringify({ protection_state: 'protected' })).safe).toBe(false)
    expect(parseBxStatus(JSON.stringify({ protection_state: 'protected', tunnel_healthy: 'true' })).safe).toBe(false)
  })

  it('garbage / non-object → unsafe', () => {
    expect(parseBxStatus('not json').safe).toBe(false)
    expect(parseBxStatus('').safe).toBe(false)
    expect(parseBxStatus('[1,2]').safe).toBe(false)
    expect(parseBxStatus('null').safe).toBe(false)
  })
})

describe('readBxStatus', () => {
  it('runs `bx status --json` via the injected exec', async () => {
    const exec = vi.fn(ok(PROTECTED))
    const v = await readBxStatus('/fake/bx', { exec })
    expect(exec).toHaveBeenCalledWith('/fake/bx', ['status', '--json'], expect.objectContaining({ timeoutMs: expect.any(Number) }))
    expect(v.safe).toBe(true)
  })

  it('bx not running (non-zero exit, error on stderr) → unsafe', async () => {
    const v = await readBxStatus('/fake/bx', { exec: async () => ({ stdout: '', stderr: 'dial unix /var/run/bx.sock: connect: no such file\n', exitCode: 1 }) })
    expect(v.safe).toBe(false)
    expect(v.detail).toContain('没在运行')
  })

  it('exec throws → unsafe, never rejects', async () => {
    const v = await readBxStatus('/fake/bx', { exec: async () => { throw new Error('EACCES') } })
    expect(v.safe).toBe(false)
    expect(v.detail).toContain('EACCES')
  })

  it('exec hangs past the timeout → unsafe', async () => {
    const v = await readBxStatus('/fake/bx', { exec: () => new Promise(() => {}), timeoutMs: 10 })
    expect(v.safe).toBe(false)
    expect(v.detail).toContain('超时')
  })

  it('exec reports killed-by-timeout exit code → unsafe', async () => {
    const v = await readBxStatus('/fake/bx', { exec: async () => ({ stdout: '', stderr: '', exitCode: 124 }) })
    expect(v.safe).toBe(false)
  })
})

describe('findBx', () => {
  it('returns the first existing candidate', () => {
    expect(findBx({ exists: (p) => p === '/opt/homebrew/bin/bx' })).toBe('/opt/homebrew/bin/bx')
  })
  it('null when not installed', () => {
    expect(findBx({ exists: () => false })).toBeNull()
  })
  it('a configured path wins; missing configured path → null', () => {
    expect(findBx({ configured: '/x/bx', exists: (p) => p === '/x/bx' })).toBe('/x/bx')
    expect(findBx({ configured: '/x/bx', exists: (p) => p === '/usr/local/bin/bx' })).toBeNull()
  })
  it('under the test runner with no injected exists → never finds the real bx', () => {
    expect(findBx()).toBeNull()
  })
})

// 真的默认执行器(defaultBxExec):对着临时替身脚本跑,绝不碰真的 bx。
describe.skipIf(process.platform === 'win32')('readBxStatus with the real defaultBxExec', () => {
  it('parses stdout of a real child process; non-zero exit, missing binary and timeout all fail closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bx-stand-in-'))
    try {
      const ok = join(dir, 'bx-ok'), down = join(dir, 'bx-down'), hang = join(dir, 'bx-hang')
      writeFileSync(ok, `#!/bin/sh\necho '${PROTECTED}'\n`); chmodSync(ok, 0o755)
      writeFileSync(down, '#!/bin/sh\necho "bx is not running" >&2\nexit 1\n'); chmodSync(down, 0o755)
      writeFileSync(hang, '#!/bin/sh\nexec sleep 5\n'); chmodSync(hang, 0o755)
      expect((await readBxStatus(ok, { exec: defaultBxExec })).safe).toBe(true)
      const d = await readBxStatus(down, { exec: defaultBxExec })
      expect(d.safe).toBe(false)
      expect(d.detail).toContain('bx is not running')
      expect((await readBxStatus(hang, { exec: defaultBxExec, timeoutMs: 200 })).safe).toBe(false)
      expect((await readBxStatus(join(dir, 'missing'), { exec: defaultBxExec })).safe).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
