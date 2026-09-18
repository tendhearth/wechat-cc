import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readApiInfo } from './api-info'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function stateDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'api-info-'))
  dirs.push(d)
  return d
}

/** Writes the info file the daemon writes on start, plus both token files. */
function seed(dir: string, opts: { omit?: 'operator' | 'file' | 'baseUrl'; bom?: boolean } = {}): void {
  const tokenFilePath = join(dir, 'token')
  const operatorTokenFilePath = join(dir, 'operator-token')
  writeFileSync(tokenFilePath, 'file-token-abc\n')
  writeFileSync(operatorTokenFilePath, 'operator-token-def\n')
  const info: Record<string, unknown> = {
    baseUrl: 'http://127.0.0.1:52100',
    tokenFilePath,
    operatorTokenFilePath,
    pid: 1234,
  }
  if (opts.omit === 'operator') delete info.operatorTokenFilePath
  if (opts.omit === 'file') delete info.tokenFilePath
  if (opts.omit === 'baseUrl') delete info.baseUrl
  writeFileSync(join(dir, 'internal-api-info.json'), `${opts.bom ? '﻿' : ''}${JSON.stringify(info)}`)
}

describe('readApiInfo', () => {
  it('reads baseUrl + both tokens, trimming the token files', () => {
    const dir = stateDir()
    seed(dir)
    const info = readApiInfo(dir)
    expect(info?.baseUrl).toBe('http://127.0.0.1:52100')
    expect(info?.token).toBe('file-token-abc')
    expect(info?.operatorToken).toBe('operator-token-def')
    expect(info?.tokenFilePath).toBe(join(dir, 'token'))
    expect(info?.operatorTokenFilePath).toBe(join(dir, 'operator-token'))
  })

  it('tolerates a UTF-8 BOM (PowerShell writes one)', () => {
    const dir = stateDir()
    seed(dir, { bom: true })
    expect(readApiInfo(dir)?.token).toBe('file-token-abc')
  })

  it('returns null when the daemon has never run (no info file)', () => {
    expect(readApiInfo(stateDir())).toBeNull()
  })

  it('returns null when the info file is missing a field or a token file', () => {
    for (const omit of ['operator', 'file', 'baseUrl'] as const) {
      const dir = stateDir()
      seed(dir, { omit })
      expect(readApiInfo(dir), omit).toBeNull()
    }
    const dir = stateDir()
    seed(dir)
    rmSync(join(dir, 'operator-token'))
    expect(readApiInfo(dir)).toBeNull()
  })

  it('returns null on a corrupt info file instead of throwing', () => {
    const dir = stateDir()
    writeFileSync(join(dir, 'internal-api-info.json'), '{ not json')
    expect(readApiInfo(dir)).toBeNull()
  })
})
