import { describe, expect, it } from 'vitest'
import { parseEnvFile } from './env-file'

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
