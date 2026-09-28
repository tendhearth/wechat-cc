import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeBinary, hydrateClaudeAuthEnvFromUserSettings } from './claude-env'

describe('claude-env', () => {
  it('CLAUDE_CODE_EXECUTABLE 指向存在的文件时优先用它', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ce-'))
    const bin = join(dir, 'claude')
    writeFileSync(bin, '')
    const prev = process.env.CLAUDE_CODE_EXECUTABLE
    process.env.CLAUDE_CODE_EXECUTABLE = bin
    try {
      expect(resolveClaudeBinary()).toBe(bin)
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE
      else process.env.CLAUDE_CODE_EXECUTABLE = prev
    }
  })
  it('hydrateClaudeAuthEnvFromUserSettings 不抛(settings.json 缺席或存在都只写 log)', () => {
    const lines: string[] = []
    expect(() => hydrateClaudeAuthEnvFromUserSettings((_t, l) => { lines.push(l) })).not.toThrow()
  })
})
