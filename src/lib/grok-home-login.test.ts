import { describe, expect, it } from 'vitest'
import { grokLoginCommand } from './grok-home'

describe('grok login command', () => {
  it('creates the dedicated home 0700 before grok writes .grok, so CC accepts the login', () => {
    const cmd = grokLoginCommand('/s')
    expect(cmd.startsWith('umask 077 && mkdir -p ')).toBe(true)
    expect(cmd).toContain("HOME='/s/executors/grok/home' grok login")
    expect(cmd.indexOf('umask 077')).toBeLessThan(cmd.indexOf('grok login'))
  })
})
