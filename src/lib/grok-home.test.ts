import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, statSync, readFileSync, symlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { removeTempDir } from './test-temp'
import { grokHome, grokHomeProblem, grokLoginCommand, grokSubprocessEnv } from './grok-home'

const dirs: string[] = []
const state = () => { const dir = mkdtempSync(join(tmpdir(), 'cc-grok-home-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir) })

describe('CC-owned Grok home', () => {
  it('refuses to construct a process environment without an explicit state directory', () => {
    expect(() => grokSubprocessEnv(undefined, {})).toThrow('专属 HOME')
  })
  it('prepares a private home and disables documented background uploads and plugin updates', () => {
    const dir = state(), env = grokSubprocessEnv(dir, {})
    expect(env.HOME).toBe(join(dir, 'executors/grok/home'))
    if (process.platform !== 'win32') expect(statSync(env.HOME!).mode & 0o777).toBe(0o700)
    const config = join(env.HOME!, '.grok/config.toml')
    if (process.platform !== 'win32') expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(parse(readFileSync(config, 'utf8'))).toMatchObject({ plugin_auto_update: false, features: { telemetry: false }, diagnostics: { error_reporting: false }, telemetry: { mixpanel_enabled: false, trace_upload: false, otel_enabled: false } })
    expect(grokHomeProblem(dir)).toContain('Grok 还没在 CC 里登录')
    expect(grokHomeProblem(dir)).toContain(grokLoginCommand(dir))
    // Existence only: deliberately invalid JSON must still count as a login file.
    writeFileSync(join(grokHome(dir), '.grok/auth.json'), 'not JSON; never parse credentials')
    expect(grokHomeProblem(dir)).toBeUndefined()
  })
  it('drops inherited home/config/auth pointers instead of reading or copying owner credentials', () => {
    const dir = state(), owner = '/owner-home-sentinel'
    const env = grokSubprocessEnv(dir, { HOME: owner, GROK_HOME: owner + '/.grok', GROK_AUTH_PATH: owner + '/auth.json', GROK_AUTH: 'do-not-forward', GROK_CONFIG: 'do-not-forward', CLAUDE_CONFIG_DIR: owner + '/.claude', XDG_CONFIG_HOME: owner + '/.config', TMPDIR: owner + '/tmp', PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:9999' })
    expect(Object.values(env).some(v => v?.includes(owner))).toBe(false)
    expect(env.GROK_AUTH).toBeUndefined()
    expect(env.GROK_CONFIG).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:9999')
    expect(grokHomeProblem(dir)).toContain('还没在 CC 里登录')
  })
  it.runIf(process.platform !== 'win32')('refuses an auth symlink as CC login evidence', () => {
    const dir = state(), other = state()
    grokSubprocessEnv(dir, {})
    // An auth symlink is also not CC-owned login evidence.
    writeFileSync(join(other, 'auth.json'), 'not credentials')
    symlinkSync(join(other, 'auth.json'), join(grokHome(dir), '.grok/auth.json'))
    expect(grokHomeProblem(dir)).toContain('还没在 CC 里登录')
  })
  it('atomically replaces configuration so concurrent readers keep a complete old file', () => {
    const dir = state()
    grokSubprocessEnv(dir, {})
    const config = join(grokHome(dir), '.grok/config.toml'), reader = join(dir, 'reader-config')
    writeFileSync(config, '# complete previous configuration\n')
    linkSync(config, reader)
    grokSubprocessEnv(dir, {})
    expect(readFileSync(reader, 'utf8')).toBe('# complete previous configuration\n')
    expect(parse(readFileSync(config, 'utf8'))).toMatchObject({ plugin_auto_update: false })
  })
})

it('does not retain a Windows USERPROFILE credential source in Grok subprocesses', () => {
  const dir = state()
  const env = grokSubprocessEnv(dir, { USERPROFILE: '/owner-home-sentinel' })
  expect(env.USERPROFILE).toBe(grokHome(dir))
})
