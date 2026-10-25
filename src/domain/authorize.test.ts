import { describe, expect, it } from 'vitest'
import { authorize, type AuthSubject } from './authorize'
import { JOB_PROFILE, TIER_PROFILES } from './user-tier'

const chat = (executor: AuthSubject['executor'], tier = TIER_PROFILES.trusted, permissionMode: AuthSubject['permissionMode'] = 'strict'): AuthSubject => ({ surface: 'chat', tier, permissionMode, executor })
const workbench: AuthSubject = { surface: 'workbench', tier: TIER_PROFILES.trusted, permissionMode: 'strict', executor: 'claude' }

// 每一层各自的理由(逐格对照见 authorize.parity.test.ts;这里钉住那些被外层兜底遮住的层,免得悄悄没了)。
describe('authorize:每一层的理由', () => {
  it('旁路只对自己跑闸门的 gemini / openai;Claude 的旁路是 SDK 静态设置,闸门里不看', () => {
    expect(authorize(chat('openai', TIER_PROFILES.guest, 'dangerously'), { name: 'Bash', kind: 'shell' })).toMatchObject({ verdict: 'allow', reason: 'bypass' })
    expect(authorize(chat('gemini', TIER_PROFILES.guest, 'dangerously'), { name: 'shell', kind: 'shell' })).toMatchObject({ verdict: 'allow', reason: 'bypass' })
    expect(authorize(chat('claude', TIER_PROFILES.guest, 'dangerously'), { name: 'Bash', kind: 'shell' })).toMatchObject({ verdict: 'deny', reason: 'tier' })
  })
  it('openai:档位说问 ⇒ 问不了、拒(relayAs);claude / gemini ⇒ 问', () => {
    expect(authorize(chat('openai'), { name: 'Bash', kind: 'shell_destructive' })).toMatchObject({ verdict: 'deny', reason: 'relay_unavailable' })
    expect(authorize(chat('claude'), { name: 'Bash', kind: 'shell_destructive' })).toMatchObject({ verdict: 'ask', reason: 'tier', consultOwnerRules: false })
    expect(authorize(chat('gemini'), { name: 'x', kind: 'shell_destructive' })).toMatchObject({ verdict: 'ask', reason: 'tier' })
  })
  it('扇出拒 reply 在档位之前;名字不合规在档位之前、旁路之后', () => {
    expect(authorize({ ...chat('claude', TIER_PROFILES.admin), fanOut: true }, { name: 'mcp__wechat__message', kind: 'message_other', replyFamily: true })).toMatchObject({ verdict: 'deny', reason: 'fanout_reply' })
    expect(authorize(chat('claude', TIER_PROFILES.admin), { name: 'mcp__wechat__message', kind: 'message_other', replyFamily: true })).toMatchObject({ verdict: 'allow' })
    expect(authorize(chat('gemini', TIER_PROFILES.admin), { name: 'a__b', kind: 'subagent', malformed: true })).toMatchObject({ verdict: 'deny', reason: 'malformed_name' })
    expect(authorize(chat('gemini', TIER_PROFILES.admin, 'dangerously'), { name: 'a__b', kind: 'subagent', malformed: true })).toMatchObject({ verdict: 'allow', reason: 'bypass' })
  })
  it('一起做的登记表:不看档位(admin 档也拒没登记的,guest 档也问登记且放进来的)', () => {
    const admin = { ...workbench, tier: TIER_PROFILES.admin }, guest = { ...workbench, tier: TIER_PROFILES.guest }
    expect(authorize(admin, { name: 'mcp__x__y', kind: 'reply', mcp: 'unregistered' })).toMatchObject({ verdict: 'deny', reason: 'unregistered' })
    expect(authorize(admin, { name: 'mcp__wechat__reply', kind: 'reply', mcp: 'not_admitted' })).toMatchObject({ verdict: 'deny', reason: 'not_admitted' })
    expect(authorize(guest, { name: 'mcp__catalog__lookup', kind: 'plugin_tool', mcp: 'admitted' })).toMatchObject({ verdict: 'ask', reason: 'admitted', consultOwnerRules: true })
  })
  it('定时任务:relay 也是拒;污点只拦网;读的范围按顺序', () => {
    const job: AuthSubject = { surface: 'job', tier: JOB_PROFILE, permissionMode: 'dangerously', executor: 'claude' }
    expect(authorize(job, { name: 'Bash', kind: 'shell_destructive' })).toMatchObject({ verdict: 'deny', reason: 'job_profile' })
    expect(authorize(job, { name: 'WebFetch', kind: 'network' }, { tainted: true })).toMatchObject({ verdict: 'deny', reason: 'job_tainted' })
    expect(authorize(job, { name: 'Read', kind: 'fs_read' }, { tainted: true })).toMatchObject({ verdict: 'allow' })
    expect(authorize(job, { name: 'Read', kind: 'fs_read' }, { readScope: { pathless: true, outside: true, redLine: 'x' } })).toMatchObject({ reason: 'job_pathless' })
    expect(authorize(job, { name: 'Read', kind: 'fs_read' }, { readScope: { pathless: false, outside: true, redLine: 'x' } })).toMatchObject({ reason: 'job_outside' })
    expect(authorize(job, { name: 'Read', kind: 'fs_read' }, { readScope: { pathless: false, outside: false, redLine: '碰到密钥' } })).toMatchObject({ reason: 'job_red_line', detail: '碰到密钥' })
  })
  it('放行规则:只在终端 / 一起做的「问」上;规则表 / 初审 / 红线的放拒才算数', () => {
    const term: AuthSubject = { surface: 'terminal', tier: TIER_PROFILES.admin, permissionMode: 'strict', executor: 'claude' }
    const reported = { name: 'Bash', kind: 'subagent', reported: true } as const
    expect(authorize(term, reported)).toMatchObject({ verdict: 'ask', consultOwnerRules: true })
    expect(authorize(term, reported, { ownerRuling: { verdict: 'allow', by: 'review' } })).toMatchObject({ verdict: 'allow', reason: 'owner_rules', by: 'review', consultOwnerRules: false })
    expect(authorize(term, reported, { ownerRuling: { verdict: 'deny', by: 'rule' } })).toMatchObject({ verdict: 'deny', by: 'rule' })
    expect(authorize(term, reported, { ownerRuling: { verdict: 'allow', by: 'default' } })).toMatchObject({ verdict: 'ask', consultOwnerRules: false })
    expect(authorize(term, reported, { ownerRuling: { verdict: 'allow', by: 'whatever' } })).toMatchObject({ verdict: 'ask' })
    // 档位放 / 拒的不进规则(一起做的 Claude 内置工具:trusted 放 Read、拒 plugin_tool)
    expect(authorize(workbench, { name: 'Read', kind: 'fs_read' })).toMatchObject({ verdict: 'allow', consultOwnerRules: false })
    // 对话:规则裁决给了也不看
    expect(authorize({ ...chat('claude', TIER_PROFILES.admin), surface: 'chat' }, reported, { ownerRuling: { verdict: 'allow', by: 'rule' } })).toMatchObject({ verdict: 'ask', consultOwnerRules: false })
  })
  it('askUser 给函数时只在走到档位那一层才取', () => {
    let reads = 0
    const askUser = () => { reads++; return 'per-tool' as const }
    authorize(chat('gemini', TIER_PROFILES.admin, 'dangerously'), { name: 'x', kind: 'subagent', askUser })
    authorize(chat('gemini', TIER_PROFILES.admin), { name: 'a__b', kind: 'subagent', askUser, malformed: true })
    expect(reads).toBe(0)
    expect(authorize(chat('gemini', TIER_PROFILES.admin), { name: 'x', kind: 'subagent', askUser })).toMatchObject({ verdict: 'allow' })
    expect(reads).toBe(1)
  })
})
