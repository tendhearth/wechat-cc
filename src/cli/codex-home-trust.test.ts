import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { stringify } from 'smol-toml'
import { codexHooksPath, installHooks } from './hook'
import { readTerminalHooks } from './terminal-hooks'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
// Independent keys/hashes from the official 0.167.0 fixture, never built by the reader.
const hashes = {
  session_start: 'ada4139167e25fbb07dac160f6f0445446c4722170ca941563504129a93d3d1c',
  stop: 'e6db525792914c050bf78d35fa30fc159a0036dede4380c58cbb781f3a3d348d',
  permission_request: '707a667fc39ed5b1633f59d01b0a696363254c672632366c3ceb536fe252f371',
  user_prompt_submit: '642a866e97e1269de335cefd3e1b043a278f800cef8a97a98169359e286c8f61',
  session_end: 'ecc6065dd687dc730bd642bd54135025c365a1933a39d4a3aab14ba024c0e363',
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cc-codex-home-')); dirs.push(home)
  const actual = join(realpathSync(home), 'actual'); mkdirSync(actual)
  const alias = join(home, 'alias'); symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const save = (keyFile: string) => writeFileSync(join(actual, 'config.toml'), stringify({ hooks: { state: Object.fromEntries(Object.entries(hashes).map(([event, hash]) => [`${keyFile}:${event}:0:0`, { trusted_hash: `sha256:${hash}` }])) } }))
  const trust = (env: Record<string, string | undefined>) => readTerminalHooks({ home, env, self: { execPath: '/opt/cc/wechat-cc', compiled: true, cliEntry: '' }, locate: () => null, exists: existsSync, codexVersion: () => '0.167.0' }).find(s => s.source === 'codex')!.trust
  installHooks(join(actual, 'hooks.json'), 'codex', '/opt/cc/wechat-cc')
  save(join(actual, 'hooks.json'))
  return { home, actual, alias, save, trust }
}

describe('Codex home resolution mirrors rust-v0.167.0 home-dir, not hooks.json realpath', () => {
  it.each(['directory symlink', 'relative directory', 'OS path alias'])('matches canonical trust keys through %s', kind => {
    const f = fixture()
    const path = kind === 'relative directory' ? relative(process.cwd(), f.alias) : kind === 'OS path alias' ? join(f.home, 'actual') : f.alias
    const before = readFileSync(join(f.actual, 'config.toml'), 'utf8')
    expect(f.trust({ CODEX_HOME: path })).toMatchObject({ state: 'trusted', evidence: 'config' })
    expect(codexHooksPath(f.home, { CODEX_HOME: path })).toBe(join(f.actual, 'hooks.json'))
    expect(readFileSync(join(f.actual, 'config.toml'), 'utf8')).toBe(before)
  })
  // File symlinks require Windows administrator/developer privileges; directory fixtures use junctions.
  it.skipIf(process.platform === 'win32')('keeps the hooks.json filename when that file itself is a symlink', () => {
    const f = fixture(), file = join(f.actual, 'hooks.json'), target = join(f.home, 'definitions.json')
    writeFileSync(target, readFileSync(file)); rmSync(file); symlinkSync(target, file)
    expect(f.trust({ CODEX_HOME: f.alias })).toMatchObject({ state: 'trusted', evidence: 'config' })
  })
  it('does not canonicalize the default .codex directory, including empty CODEX_HOME', () => {
    const f = fixture(), defaultDir = join(f.home, '.codex')
    symlinkSync(f.actual, defaultDir, process.platform === 'win32' ? 'junction' : 'dir')
    f.save(join(defaultDir, 'hooks.json'))
    expect(f.trust({})).toMatchObject({ state: 'trusted', evidence: 'config' })
    expect(f.trust({ CODEX_HOME: '' })).toMatchObject({ state: 'trusted', evidence: 'config' })
  })
  it('keeps missing or non-directory explicit homes unconfirmed without creating anything', () => {
    const f = fixture(), missing = join(f.home, 'missing'), ordinaryFile = join(f.home, 'ordinary-file')
    writeFileSync(ordinaryFile, 'unchanged')
    expect(f.trust({ CODEX_HOME: missing })).toBeUndefined()
    expect(f.trust({ CODEX_HOME: ordinaryFile })).toBeUndefined()
    expect(existsSync(missing)).toBe(false)
    expect(readFileSync(ordinaryFile, 'utf8')).toBe('unchanged')
  })
})
