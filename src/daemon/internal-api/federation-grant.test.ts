import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grantPath, writeGrant, readGrant, revokeGrant } from './federation-grant'

const tmp = () => mkdtempSync(join(tmpdir(), 'fed-grant-'))

describe('federation-grant', () => {
  it('writeGrant creates a 0600 grant, readGrant round-trips', () => {
    const dir = tmp()
    const g = writeGrant(dir, 1234, 'hearth')
    expect(g).toEqual({ integration: 'hearth', ts: 1234 })
    expect(statSync(grantPath(dir)).mode & 0o777).toBe(0o600)
    expect(readGrant(dir)).toEqual({ integration: 'hearth', ts: 1234 })
  })
  it('readGrant returns null when missing or malformed', () => {
    const dir = tmp()
    expect(readGrant(dir)).toBeNull()
    writeFileSync(grantPath(dir), '{ not json', { mode: 0o600 })
    expect(readGrant(dir)).toBeNull()
  })
  it('writeGrant forces 0600 even if the file pre-exists at looser perms', () => {
    const dir = tmp()
    writeFileSync(grantPath(dir), '{}', { mode: 0o644 })
    writeGrant(dir, 1)
    expect(statSync(grantPath(dir)).mode & 0o777).toBe(0o600)
  })
  it('revokeGrant removes an existing grant, false when none', () => {
    const dir = tmp()
    expect(revokeGrant(dir)).toBe(false)
    writeGrant(dir, 1)
    expect(revokeGrant(dir)).toBe(true)
    expect(readGrant(dir)).toBeNull()
  })
})
