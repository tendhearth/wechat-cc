/**
 * 定时任务只读档的 canUseTool(wire-model-options.ts 的 profileGate)的表:每一种调用的确切结果、拒的那句话,
 * 以及「读过本机 ⇒ 这一轮不再上网」在每一对先后调用上的样子。2026-10-28 第四轮:原来这些只靠
 * authorize.parity.test.ts 那一面「与旧实现逐格相同」兜着,那一面删了,这里直接写出来。
 * 只用真文件系统(临时目录)和真的红线判定,不替换任何内部模块。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { JOB_PROFILE, REVIEW_PROFILE, TIER_PROFILES, type TierProfile } from '../../domain/user-tier'
import { wireModelOptions } from './wire-model-options'
import { DEFAULT_CLAUDE_MODEL } from '../../adapters/executors/claude/claude-agent-provider'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'job-gate-')))
const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'job-gate-state-')))
mkdirSync(join(root, 'src'), { recursive: true })

const gateFor = (tp: TierProfile) => wireModelOptions({ stateDir }, {
  plugins: { wechatStdioForClaude: null, delegateStdioForClaude: null, pluginMcpForClaude: {} }, permissionMode: 'strict',
  buildCanUseTool: () => { throw new Error('标准档的闸门不该给定时任务建') }, claudeBin: undefined,
}).sdkOptionsForProject('job:j', root, tp, 'chat', undefined, undefined, { permissionMode: 'strict' }).canUseTool!
const OPTS = { signal: new AbortController().signal } as never
const deny = (tool: string, why: string) => ({ behavior: 'deny', message: `这一轮是只读的定时任务,不能用 ${tool}(${why})。` })
const allow = (input: unknown) => ({ behavior: 'allow', updatedInput: input })

const NOT_IN = '不在只读档里'
const OUTSIDE = '只能读这个项目目录里的文件'

/** [工具, 输入, 定时档第一次调用的结果(null = 放), 这一下算不算「读过本机」] */
const ROWS: [string, Record<string, unknown>, string | null, boolean][] = [
  ['Read', { file_path: join(root, 'a.txt') }, null, true],
  ['Read', { file_path: 'src/b.ts' }, null, true],                                   // 相对路径按项目根算
  ['Read', { file_path: '/etc/passwd' }, OUTSIDE, false],
  ['Read', { file_path: join(root, '..', 'x') }, OUTSIDE, false],
  ['Read', { file_path: join(homedir(), '.aws', 'credentials') }, OUTSIDE, false],
  ['Read', {}, null, true],                                                          // 没写路径 = 项目目录
  ['Glob', { pattern: '/abs/**' }, OUTSIDE, false],                                  // 绝对的 glob 当路径看
  ['Glob', { pattern: 'src/**' }, null, true],
  ['Grep', { pattern: 'x', path: root }, null, true],
  ['Grep', { pattern: 'x', path: homedir() }, OUTSIDE, false],
  ['LS', { path: '/' }, OUTSIDE, false],
  ['mcp__wechat__memory_read', {}, null, true],
  ['mcp__wechat__observations_list', {}, null, true],
  ['mcp__wechat__reply', { text: 'x' }, null, false],
  ['mcp__wechat__memory_write', {}, NOT_IN, false],
  ['WebFetch', { url: 'https://example.com' }, null, false],
  ['WebSearch', { query: 'x' }, null, false],
  ['Bash', { command: 'ls' }, NOT_IN, false],
  ['Write', { file_path: join(root, 'a') }, NOT_IN, false],
  ['Task', {}, NOT_IN, false],
  ['SomethingNew', {}, NOT_IN, false],
]

describe('定时任务只读档:单次调用', () => {
  it.each(ROWS)('%s %j', async (tool, input, why) => {
    const got = await gateFor(JOB_PROFILE)(tool, input, OPTS)
    expect(got).toEqual(why === null ? allow(input) : deny(tool, why))
    if (why === null) expect((got as { updatedInput: unknown }).updatedInput).toBe(input)   // 原样交回,不复制
  })

  it('审查档:同一张表,只是网一律不给', async () => {
    for (const [tool, input, why] of ROWS) {
      const want = tool === 'WebFetch' || tool === 'WebSearch' ? NOT_IN : why
      expect(await gateFor(REVIEW_PROFILE)(tool, input, OPTS), tool).toEqual(want === null ? allow(input) : deny(tool, want))
    }
  })

  it('红线:项目里的密钥 / CC 的状态目录 ⇒ 拒,话里带红线给的理由', async () => {
    for (const p of [join(root, '.env'), join(root, '.ssh', 'id_rsa')]) {
      const got = await gateFor(JOB_PROFILE)('Read', { file_path: p }, OPTS) as { behavior: string; message: string }
      expect(got.behavior, p).toBe('deny')
      expect(got.message, p).toMatch(/^这一轮是只读的定时任务,不能用 Read\(.+\)。$/)
      expect(got.message, p).not.toContain(NOT_IN)
      expect(got.message, p).not.toContain(OUTSIDE)
    }
    const st = await gateFor(JOB_PROFILE)('Read', { file_path: join(stateDir, 'access.json') }, OPTS) as { behavior: string; message: string }
    expect(st.behavior).toBe('deny')   // 状态目录不在项目里:按范围先拒
  })

  it('MCP 的读文件工具没给路径 ⇒ 拒(没有路径);内置的不给路径 = 项目目录', async () => {
    // attach_file:wechat MCP 里分类成读文件的工具
    const g = gateFor(JOB_PROFILE)
    expect(await g('mcp__wechat__attach_file', {}, OPTS)).toEqual(deny('mcp__wechat__attach_file', '没有路径'))
    expect(await g('mcp__wechat__attach_file', { pattern: 'src/**' }, OPTS)).toEqual(deny('mcp__wechat__attach_file', '没有路径'))  // 相对的 glob 不算路径
    expect(await g('mcp__wechat__attach_file', { path: '/etc/passwd' }, OPTS)).toEqual(deny('mcp__wechat__attach_file', OUTSIDE))
    expect(await g('mcp__wechat__attach_file', { path: join(root, 'a.txt') }, OPTS)).toEqual(allow({ path: join(root, 'a.txt') }))
    expect(await gateFor(JOB_PROFILE)('mcp__wechat__attach_file', { pattern: join(root, '*.ts') }, OPTS)).toEqual(allow({ pattern: join(root, '*.ts') }))
    expect(await g('Read', {}, OPTS)).toEqual(allow({}))
  })

  it('input 为 undefined 也不炸', async () => {
    expect(await gateFor(JOB_PROFILE)('WebSearch', undefined as never, OPTS)).toEqual({ behavior: 'allow', updatedInput: undefined })
  })
})

describe('污点:读过本机的东西以后,这一轮不再上网;新的一轮(新闸门)重新算', () => {
  const NET: [string, Record<string, unknown>][] = [['WebFetch', { url: 'https://example.com' }], ['WebSearch', { query: 'x' }]]
  it.each(ROWS)('先 %s %j,再上网', async (tool, input, why, taints) => {
    const g = gateFor(JOB_PROFILE)
    await g(tool, input, OPTS)
    for (const [n, i] of NET) expect(await g(n, i, OPTS), n).toEqual(taints ? deny(n, '这一轮已经读过本机的东西,不再上网') : allow(i))
    void why
  })
  it('先上网再读:都放;读完以后再上网才拒', async () => {
    const g = gateFor(JOB_PROFILE)
    expect(await g('WebSearch', { query: 'a' }, OPTS)).toEqual(allow({ query: 'a' }))
    expect(await g('Read', { file_path: join(root, 'a.txt') }, OPTS)).toEqual(allow({ file_path: join(root, 'a.txt') }))
    expect((await g('WebSearch', { query: 'b' }, OPTS)).behavior).toBe('deny')
    expect(await gateFor(JOB_PROFILE)('WebSearch', { query: 'c' }, OPTS)).toEqual(allow({ query: 'c' }))
  })
  it('被拒的读不算读过', async () => {
    const g = gateFor(JOB_PROFILE)
    await g('Read', { file_path: '/etc/passwd' }, OPTS)
    await g('Read', { file_path: join(root, '.env') }, OPTS)
    expect(await g('WebSearch', { query: 'x' }, OPTS)).toEqual(allow({ query: 'x' }))
  })
})

describe('Claude 用哪个模型:只认全局是 claude 且钉了 model 的', () => {
  const ROWS: [Record<string, unknown> | null, 'pinned' | 'default'][] = [
    [{ provider: 'claude', model: 'claude-x-1' }, 'pinned'],
    [{ provider: 'claude' }, 'default'],
    [{ provider: 'codex', model: 'claude-x-1' }, 'default'],
    [null, 'default'],
  ]
  it.each(ROWS)('%j ⇒ %s', (config, want) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wmo-model-')))
    if (config) writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(config))
    const s = wireModelOptions({ stateDir: dir }, { plugins: { wechatStdioForClaude: null, delegateStdioForClaude: null, pluginMcpForClaude: {} }, permissionMode: 'strict', buildCanUseTool: () => (async () => ({ behavior: 'allow' })) as never, claudeBin: undefined })
    const model = want === 'pinned' ? 'claude-x-1' : DEFAULT_CLAUDE_MODEL
    expect(s.currentClaudeModel()).toBe(model)
    expect(s.currentModelFor('claude')).toBe(model)
    expect(s.sdkOptionsForProject('P', root, TIER_PROFILES.admin, 'c').model).toBe(model)
  })
})

describe('标准档仍走按对话取档的闸门', () => {
  it('admin / trusted / guest 不建只读闸门', () => {
    const marker = (async () => ({ behavior: 'allow' })) as never
    const s = wireModelOptions({ stateDir }, { plugins: { wechatStdioForClaude: null, delegateStdioForClaude: null, pluginMcpForClaude: {} }, permissionMode: 'strict', buildCanUseTool: () => marker, claudeBin: undefined })
    for (const t of ['admin', 'trusted', 'guest'] as const) expect(s.sdkOptionsForProject('P', root, TIER_PROFILES[t], 'c').canUseTool).toBe(marker)
  })
})
