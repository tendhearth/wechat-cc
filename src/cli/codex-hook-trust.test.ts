import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'smol-toml'
import { installHooks } from './hook'
import { codexHookDefinitions, readCodexHookTrust, recordCodexHookInvocation } from './codex-hook-trust'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cc-codex-trust-')); dirs.push(home)
  const file = join(home, 'codex', 'hooks.json'), evidenceFile = join(home, 'cc', 'codex-hook-evidence.json')
  installHooks(file, 'codex', '/opt/cc/wechat-cc')
  const config = join(home, 'codex', 'config.toml')
  const options = { evidenceFile, version: '0.167.0' }
  const trust = () => readCodexHookTrust(file, options)
  const save = (state: Record<string, unknown>, extra = {}) => writeFileSync(config, stringify({ ...extra, hooks: { state } }))
  const states = () => Object.fromEntries(codexHookDefinitions(file, options.version).map(h => [h.key, { trusted_hash: h.hash }]))
  return { file, config, evidenceFile, options, trust, save, states }
}
describe('Codex trust, isolated CODEX_HOME; only Codex writes trust', () => {
  it('matches official normalized hashes and source-position keys', () => {
    const f = fixture(), defs = codexHookDefinitions(f.file, '0.167.0')
    expect(defs.map(d => d.hash)).toEqual([
      'sha256:ada4139167e25fbb07dac160f6f0445446c4722170ca941563504129a93d3d1c',
      'sha256:e6db525792914c050bf78d35fa30fc159a0036dede4380c58cbb781f3a3d348d',
      'sha256:707a667fc39ed5b1633f59d01b0a696363254c672632366c3ceb536fe252f371',
      'sha256:642a866e97e1269de335cefd3e1b043a278f800cef8a97a98169359e286c8f61',
      'sha256:ecc6065dd687dc730bd642bd54135025c365a1933a39d4a3aab14ba024c0e363',
    ])
    expect(defs[0]!.key).toBe(`${f.file}:session_start:0:0`)
    expect(codexHookDefinitions(f.file, '0.144.4').map(d => d.event)).toEqual(['SessionStart', 'PermissionRequest'])
  })
  it('untrusted → trusted → changed → trusted; status reads never write Codex files', () => {
    const f = fixture(); f.save({})
    expect(f.trust().state).toBe('untrusted')
    f.save(f.states()); const before = readFileSync(f.config, 'utf8')
    expect(f.trust()).toMatchObject({ state: 'trusted', evidence: 'config' })
    expect(readFileSync(f.config, 'utf8')).toBe(before)
    const cfg = JSON.parse(readFileSync(f.file, 'utf8')); cfg.hooks.SessionStart[0].hooks[0].timeout = 2
    writeFileSync(f.file, JSON.stringify(cfg))
    expect(f.trust().state).toBe('changed')
    f.save(f.states()); expect(f.trust().state).toBe('trusted')
  })
  it('partial trust, disabled hooks and global switch never become connected from old invocations', () => {
    const f = fixture(); recordCodexHookInvocation(f.file, f.evidenceFile, f.options.version)
    const s = f.states(); delete s[Object.keys(s)[0]!]; f.save(s)
    expect(f.trust().state).toBe('untrusted')
    f.save({ ...f.states(), [Object.keys(f.states())[0]!]: { enabled: false, trusted_hash: codexHookDefinitions(f.file, '0.167.0')[0]!.hash } })
    expect(f.trust()).toMatchObject({ state: 'untrusted', disabled: true })
    f.save(f.states(), { features: { hooks: false } })
    expect(f.trust()).toMatchObject({ state: 'untrusted', disabled: true })
  })
  it('unreadable records use definition-bound invocation evidence; changed definitions invalidate it', () => {
    const f = fixture(); writeFileSync(f.config, 'invalid [')
    expect(f.trust().state).toBe('untrusted')
    recordCodexHookInvocation(f.file, f.evidenceFile, f.options.version)
    expect(f.trust()).toMatchObject({ state: 'trusted', evidence: 'invocation' })
    installHooks(f.file, 'codex', '/another/cc hook codex')
    expect(f.trust().state).toBe('changed')
    expect(readFileSync(f.config, 'utf8')).toBe('invalid [')
  })
  it('key positions matter; unrelated formatting and description do not', () => {
    const f = fixture(); f.save(f.states())
    const cfg = JSON.parse(readFileSync(f.file, 'utf8')); cfg.description = 'other metadata'
    writeFileSync(f.file, JSON.stringify(cfg, null, 4)); expect(f.trust().state).toBe('trusted')
    cfg.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: 'other' }] })
    writeFileSync(f.file, JSON.stringify(cfg)); expect(f.trust().state).toBe('changed')
  })
  it('unrelated trusted handlers do not imply CC was previously confirmed', () => {
    const f = fixture(); f.save({ [`${f.file}:stop:9:0`]: { trusted_hash: 'sha256:third-party' } })
    expect(f.trust().state).toBe('untrusted')
  })
  it('0.144.4 only requires the two supported synchronous definitions', () => {
    const f = fixture(); f.save(Object.fromEntries(codexHookDefinitions(f.file, '0.144.4').map(d => [d.key, { trusted_hash: d.hash }])))
    expect(readCodexHookTrust(f.file, { version: 'codex-cli 0.144.4' }).state).toBe('trusted')
    expect(f.trust().state).toBe('untrusted')
  })
  it('normalizes SessionEnd default timeout, nullable options and supported empty matchers like Codex', () => {
    const f = fixture(), cfg = JSON.parse(readFileSync(f.file, 'utf8'))
    const h = cfg.hooks.SessionEnd[0].hooks[0]
    h.command = '/opt/cc/wechat-cc hook codex'
    delete h.timeout; h.statusMessage = null
    cfg.hooks.SessionEnd[0].matcher = ''
    writeFileSync(f.file, JSON.stringify(cfg))
    const absent = codexHookDefinitions(f.file, '0.167.0').find(d => d.event === 'SessionEnd')!.hash
    h.timeout = 1; delete h.statusMessage
    writeFileSync(f.file, JSON.stringify(cfg))
    expect(codexHookDefinitions(f.file, '0.167.0').find(d => d.event === 'SessionEnd')!.hash).toBe(absent)
    delete cfg.hooks.SessionEnd[0].matcher
    writeFileSync(f.file, JSON.stringify(cfg))
    expect(codexHookDefinitions(f.file, '0.167.0').find(d => d.event === 'SessionEnd')!.hash).not.toBe(absent)
  })
  it('an upgrade cannot reuse invocation evidence from an earlier Codex version', () => {
    const f = fixture(); recordCodexHookInvocation(f.file, f.evidenceFile, 'codex-cli 0.167.0')
    expect(f.trust().state).toBe('trusted')
    expect(readCodexHookTrust(f.file, { evidenceFile: f.evidenceFile, version: 'codex-cli 0.168.0' }).state).toBe('changed')
    recordCodexHookInvocation(f.file, f.evidenceFile, 'codex-cli 0.168.0')
    expect(readCodexHookTrust(f.file, { evidenceFile: f.evidenceFile, version: '0.168.0' }).state).toBe('trusted')
  })
})
