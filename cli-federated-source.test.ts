import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { federatedSourceAuthorize, federatedSourceDeauthorize, federatedSourceStatus, resolveFederatedSourceVerb } from './cli-federated-source'
import { grantPath } from './src/daemon/internal-api/federation-grant'
import { existsSync } from 'node:fs'

const tmp = () => mkdtempSync(join(tmpdir(), 'cli-fed-'))

function writeFakeInfo(dir: string): string {
  const info = join(dir, 'internal-api-info.json')
  writeFileSync(info, JSON.stringify({
    baseUrl: 'http://127.0.0.1:9999',
    tokenFilePath: join(dir, 'token'),
    operatorTokenFilePath: join(dir, 'operator-token'),
  }))
  return info
}

describe('federated-source verbs', () => {
  it('authorize writes a grant, status reports it, deauthorize removes it', () => {
    const dir = tmp()
    const info = writeFakeInfo(dir)
    const out: string[] = []
    const print = (s: string) => out.push(s)

    federatedSourceAuthorize(info, 1000, print)
    expect(existsSync(grantPath(dir))).toBe(true)
    expect(out.join('\n')).toMatch(/authorized/i)

    out.length = 0
    expect(federatedSourceStatus(info, print)).toBe(true)
    expect(out.join('\n')).toMatch(/authorized/i)
    expect(out.join('\n')).toMatch(/baseUrl|127\.0\.0\.1/)

    out.length = 0
    federatedSourceDeauthorize(info, print)
    expect(existsSync(grantPath(dir))).toBe(false)
    expect(out.join('\n')).toMatch(/revoked/i)

    out.length = 0
    expect(federatedSourceStatus(info, print)).toBe(false)
    expect(out.join('\n')).toMatch(/not authorized/i)
  })

  it('deauthorize is a no-op (and says so) when no grant exists', () => {
    const dir = tmp()
    writeFakeInfo(dir)
    const out: string[] = []
    federatedSourceDeauthorize(join(dir, 'internal-api-info.json'), (s) => out.push(s))
    expect(out.join('\n')).toMatch(/not authorized|no grant/i)
  })

  it('authorize creates the state dir when it does not exist yet (pre-daemon authorization)', () => {
    const dir = tmp()
    // infoPath's dirname does NOT exist — mirrors an owner running --authorize
    // before the daemon has ever created ~/.claude/channels/wechat/.
    const stateDir = join(dir, 'not-yet-created')
    const info = join(stateDir, 'internal-api-info.json')
    expect(existsSync(stateDir)).toBe(false)
    const out: string[] = []
    const print = (s: string) => out.push(s)

    expect(() => federatedSourceAuthorize(info, 1000, print)).not.toThrow()
    expect(existsSync(stateDir)).toBe(true)
    expect(existsSync(grantPath(stateDir))).toBe(true)
    expect(federatedSourceStatus(info, print)).toBe(true)
  })
})

describe('resolveFederatedSourceVerb', () => {
  it('picks the single set verb', () => {
    expect(resolveFederatedSourceVerb({ authorize: true })).toBe('authorize')
    expect(resolveFederatedSourceVerb({ deauthorize: true })).toBe('deauthorize')
    expect(resolveFederatedSourceVerb({ status: true })).toBe('status')
  })

  it('defaults to run mode when no verb flag is set', () => {
    expect(resolveFederatedSourceVerb({})).toBe('run')
  })

  it('rejects more than one verb flag instead of silently dropping one', () => {
    expect(resolveFederatedSourceVerb({ authorize: true, deauthorize: true })).toEqual({
      error: expect.stringMatching(/at most one/i),
    })
    expect(resolveFederatedSourceVerb({ status: true, deauthorize: true })).toEqual({
      error: expect.stringMatching(/at most one/i),
    })
    expect(resolveFederatedSourceVerb({ authorize: true, status: true, deauthorize: true })).toEqual({
      error: expect.stringMatching(/at most one/i),
    })
  })
})
