import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import { setPluginEnabled } from '../plugins/registry'
import { resolveBundledPluginsDir, writePluginsSourcePointer } from '../plugins/paths'
import { wirePlugins } from './wire-plugins'

const ctx = () => ({ stateDir: mkdtempSync(join(tmpdir(), 'wp-')), log: () => {} })

describe('wirePlugins', () => {
  it('没有 internalApi ⇒ 所有 stdio spec 为 null,delegate 表为空', () => {
    const s = wirePlugins({}, ctx())
    expect(s.wechatStdioForClaude).toBeNull()
    expect(s.wechatStdioForCodex).toBeNull()
    expect(s.wechatStdioForAgy).toBeNull()
    expect(s.delegateStdioForClaude).toBeNull()
    expect(Object.keys(s.delegateStdioByProvider)).toEqual([])
    expect(s.knowledgePluginNames).toEqual(Object.keys(s.pluginMcp))
  })
  it('有 internalApi ⇒ 每家 provider 一份 wechat spec;声明 defaultPeer 的家有 delegate spec', () => {
    const s = wirePlugins(
      { internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: join(tmpdir(), 'tok') } },
      ctx(),
    )
    expect(s.wechatStdioForClaude?.env).toMatchObject({ WECHAT_INTERNAL_API: 'http://127.0.0.1:0' })
    expect(s.wechatStdioForCursor).not.toBeNull()
    expect(s.wechatStdioForOpenai).not.toBeNull()
    expect(s.wechatStdioForGemini).not.toBeNull()
    expect(s.wechatStdioForAgy).not.toBeNull()
    // claude 声明 defaultPeer=codex ⇒ 有 delegate spec;表与 ForX 字段一致。
    expect(s.delegateStdioForClaude).not.toBeNull()
    expect(s.delegateStdioForClaude).toBe(s.delegateStdioByProvider.claude ?? null)
    expect(s.delegateStdioForCodex).toBe(s.delegateStdioByProvider.codex ?? null)
    for (const v of Object.values(s.pluginMcpForClaude)) expect(v.type).toBe('stdio')
  })
})

let root: string
let savedEnv: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wcc-wire-plugins-'))
  savedEnv = process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
  delete process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
  else process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = savedEnv
  removeTempDir(root)
})

function run(stateDir: string, resolve?: Parameters<typeof wirePlugins>[2]) {
  const lines: string[] = []
  const slice = wirePlugins({ internalApi: undefined } as never, { stateDir, log: (tag: string, line: string) => { lines.push(`[${tag}] ${line}`) } } as never, resolve)
  return { slice, lines }
}

/** A fake source checkout whose `plugins/` really holds `names` — what the MAIN checkout looks like. */
function fakeRepo(names: string[]): string {
  const repo = join(root, 'repo')
  for (const n of names) {
    mkdirSync(join(repo, 'plugins', n), { recursive: true })
    writeFileSync(join(repo, 'plugins', n, 'wechat-cc.plugin.json'), JSON.stringify({ name: n, kind: 'mcp', version: '1.0.0', spawn: { command: process.execPath } }))
  }
  return repo
}
/** Hermetic resolver: source mode against the fake repo, no env, real pointer lookup in `stateDir`. */
const resolverFor = (repo: string) => (stateDir?: string) =>
  resolveBundledPluginsDir({ env: undefined, stateDir, compiled: false, execPath: '/nowhere/bin', sourceRepoRoot: repo })

describe('wirePlugins — 内置插件来源与「丢了要出声」(2026-09-30 回归)', () => {
  it('loads plugins from the owner pointer in the state dir (packaged daemon, empty bundle)', () => {
    const stateDir = join(root, 'state')
    const plugins = join(root, 'owner', 'plugins')
    mkdirSync(join(plugins, 'demo'), { recursive: true })
    writeFileSync(join(plugins, 'demo', 'wechat-cc.plugin.json'), JSON.stringify({ name: 'demo', kind: 'mcp', version: '1.0.0', spawn: { command: process.execPath } }))
    writePluginsSourcePointer(stateDir, plugins)
    const { slice, lines } = run(stateDir)
    expect(slice.loadedPlugins.map(p => p.name)).toContain('demo')
    expect(slice.pluginsHealth.via).toBe('pointer')
    expect(slice.pluginsHealth.bundled_dir).toBe(plugins)
    expect(lines.join('\n')).toContain(plugins)
  })

  // Hermetic (review fix round 1): with the live resolver this ran against the
  // REAL <repo>/plugins — empty in a worktree/CI, full of symlinks in the main
  // checkout, where it then failed. The resolver is injected; the fake repo
  // is populated on purpose to prove a full plugins dir doesn't mask the miss.
  it('enabled-but-missing plugins are logged loudly and land in the health snapshot — even next to a populated <repo>/plugins', () => {
    const stateDir = join(root, 'state')
    setPluginEnabled(stateDir, 'wxsearch', true)
    const { slice, lines } = run(stateDir, resolverFor(fakeRepo(['wxvault', 'wxmedia'])))
    expect(slice.pluginsHealth.via).toBe('repo')
    expect(slice.loadedPlugins.map(p => p.name).sort()).toEqual(['wxmedia', 'wxvault'])
    expect(slice.pluginsHealth.expected_missing).toEqual(['wxsearch'])
    expect(lines.some(l => l.includes('WARNING') && l.includes('wxsearch'))).toBe(true)
  })

  it('a populated <repo>/plugins with nothing expected missing stays quiet', () => {
    const stateDir = join(root, 'state')
    const { slice, lines } = run(stateDir, resolverFor(fakeRepo(['wxvault'])))
    expect(slice.pluginsHealth.expected_missing).toEqual([])
    expect(lines.some(l => l.includes('WARNING'))).toBe(false)
  })

  it('registered source that now holds nothing ⇒ boot WARNING naming it', () => {
    const stateDir = join(root, 'state')
    writePluginsSourcePointer(stateDir, join(root, 'gone'), ['wxvault'])
    const { slice, lines } = run(stateDir, resolverFor(fakeRepo([])))
    expect(slice.pluginsHealth.pointer_broken).toBe(true)
    expect(slice.pluginsHealth.expected_missing).toEqual(['wxvault'])
    expect(lines.some(l => l.includes('WARNING') && l.includes(join(root, 'gone')))).toBe(true)
  })
})
