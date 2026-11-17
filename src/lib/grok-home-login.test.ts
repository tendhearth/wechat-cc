import { describe, expect, it } from 'vitest'
import { grokHome, grokLoginCommand } from './grok-home'

describe('grok login command', () => {
  it('creates the dedicated home 0700 before grok writes .grok, so CC accepts the login', () => {
    const cmd = grokLoginCommand('/s')
    expect(cmd.startsWith('umask 077 && mkdir -p ')).toBe(true)
    expect(cmd).toContain(`HOME='${grokHome('/s')}' grok login`)
    expect(cmd.indexOf('umask 077')).toBeLessThan(cmd.indexOf('grok login'))
  })
})

it('Windows login isolates USERPROFILE and clears inherited Grok credential locations', () => {
  const cmd = grokLoginCommand('/s', 'powershell')
  expect(cmd).toContain('$env:USERPROFILE = $env:HOME')
  expect(cmd).toContain('Env:GROK_*')
  expect(cmd).toContain('Remove-Item')
})
it('POSIX login clears inherited home/auth overrides before the official CLI', () => {
  const cmd = grokLoginCommand('/s')
  expect(cmd).toContain('unset GROK_HOME')
  expect(cmd).toContain('GROK_AUTH_PATH')
})
