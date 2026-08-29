import { describe, expect, it } from 'vitest'
import { parseEnvFile, upsertEnvFile } from './env-file'

describe('parseEnvFile', () => {
  it('parses KEY=VALUE lines, ignoring comments, blanks and export prefixes', () => {
    expect(parseEnvFile([
      '# provider keys',
      'CURSOR_API_KEY=abc123',
      '',
      'export GEMINI_API_KEY=g-456',
      'WECHAT_OPENAI_API_KEY="quoted value"',
      "SINGLE='sq'",
    ].join('\n'))).toEqual({
      CURSOR_API_KEY: 'abc123',
      GEMINI_API_KEY: 'g-456',
      WECHAT_OPENAI_API_KEY: 'quoted value',
      SINGLE: 'sq',
    })
  })

  it('keeps = signs inside values; drops malformed lines and invalid names', () => {
    expect(parseEnvFile('TOKEN=a=b=c\nnot a line\n1BAD=x\n=novalue')).toEqual({ TOKEN: 'a=b=c' })
  })

  it('empty/garbage input → {}', () => {
    expect(parseEnvFile('')).toEqual({})
    expect(parseEnvFile('###')).toEqual({})
  })
})


describe('upsertEnvFile', () => {
  it('updates existing keys in place and appends new ones, preserving comments and unknown lines', () => {
    const before = '# provider keys\nGEMINI_API_KEY=old\nsome garbage line\n'
    const after = upsertEnvFile(before, { GEMINI_API_KEY: 'new-g', WECHAT_OPENAI_API_KEY: 'sk-x' })
    expect(after).toContain('# provider keys')
    expect(after).toContain('some garbage line')
    expect(after).toContain('GEMINI_API_KEY=new-g')
    expect(after).not.toContain('GEMINI_API_KEY=old')
    expect(after.trim().endsWith('WECHAT_OPENAI_API_KEY=sk-x')).toBe(true)
    expect(parseEnvFile(after)['GEMINI_API_KEY']).toBe('new-g')
  })

  it('empty original → just the new keys', () => {
    expect(parseEnvFile(upsertEnvFile('', { A_KEY: 'v' }))).toEqual({ A_KEY: 'v' })
  })
})
