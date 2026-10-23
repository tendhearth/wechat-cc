/**
 * 重构第二批 · 步 1b(评审 #468,spec 2026-10-20-refactor-batch2-design §5):微信命令的**端到端**快照。只加测试。
 *
 * #468 的基线只记「每套 probe 认不认」,证明不了顺序、谁能用(who 闸)、回了什么。这里真启动 daemon(假 ilink + 假模型),
 * 同一份语料按主人 / trusted / 访客三档各发一遍,每句记:交给模型了没有(AGENT)、回了什么(前 40 字)、或者什么都没回。
 * 步 2 / 步 3 搬命令时对的就是这份;除 §1.5 列出的 bug 修复外,结果要逐条一致。
 *
 * 会真的动手的命令不进语料:自改 <需求>(起自改流水线)、/update(自更新)、派<手>(委派)、整理记忆(重算画像)。
 * 有状态的(/codex 换模式、导入记忆等粘贴)放在各自段落最后,并紧跟一句复原。
 */
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

/** 每次都变的东西(启动时间、邀请码)换成占位,快照才稳。 */
const stable = (t: string) => t.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<时间>').replace(/\b\d{6}\b|(?<=:)\d{6}/g, '<码>')

const CORPUS = [
  // 普通聊天(都该进模型)
  '你好', '帮我看看这个报错', '@codex 帮我看看这个函数', '@claude 你觉得呢', '看 README 里怎么写的', '早报那个能不能早点发', '经验告诉我别这么干', '1', '好', '同意你的看法',
  // 任务(工作台没接线:看「任务」这一族怎么落)
  '任务', '任务 列表', '/task',
  // admin
  '/health', '看记忆', '背包', '有哪些手', '/botname', '放行规则关掉',
  // mode
  '/set', '/whoami', '/help', '/foo', '/cli', '/today', '/visit',
  // 权限回复(没有待批准的)
  'y', '同意 07',
  // 文本命令链
  '定时', '日历', '做过的事', '经验', '终端', '日报', '看 ab12', '@ab12 继续',
  // command-router
  '串门', '配对', '邀请码', '待批准', '认识 ab12',
  // 有状态的放最后
  '导入记忆', '不要',
  '/codex', '/solo',
]

const tiers = { owner: 'owner', trusted: 'friend', guest: 'guest' } as const

describe('e2e: 微信命令路由快照(三档 × 同一份语料)', () => {
  it('what each message ends up as, per tier', async () => {
    const agent: string[] = []
    const daemon = await startTestDaemon({
      dangerously: true,
      access: { admins: ['owner'], trusted: ['friend'], allowFrom: ['owner', 'friend', 'guest'] },
      knownUsers: { owner: '主人', friend: '朋友', guest: '访客' },
      claudeScript: { async onDispatch(text) { agent.push(text); return { toolCalls: [], finalText: 'AGENT' } } },
      codexScript: { async onDispatch(text) { agent.push(text); return { toolCalls: [], finalText: 'AGENT' } } },
    })
    const out: Record<string, Record<string, string>> = {}
    try {
      let t = Date.now()
      for (const [tier, chat] of Object.entries(tiers)) {
        out[tier] = {}
        for (const text of CORPUS) {
          const before = daemon.ilink.outbox().filter(m => m.endpoint === 'sendmessage' && m.chatId === chat).length
          daemon.sendText(chat, text, { createTimeMs: (t += 1000) })
          const got = await daemon.waitForOutbound(ms => ms.filter(m => m.endpoint === 'sendmessage' && m.chatId === chat).length > before, 2500).catch(() => null)
          const fresh = (got ?? daemon.ilink.outbox()).filter(m => m.endpoint === 'sendmessage' && m.chatId === chat).slice(before).map(m => m.text ?? '').join(' | ')
          out[tier]![text] = fresh ? stable(fresh.replace(/\s+/g, ' ')).slice(0, 40) : '(没回)'
        }
      }
    } finally { await daemon.stop() }
    expect(out).toMatchSnapshot()
  }, 600_000)
})

// 注:这里假模型只让首次探测失败,llm 子系统并没进「暂停」;§1.5 bug 2(llm 暂停时命令到不了)的证明在
// src/daemon/wiring/pipeline-deps-llm-down-commands.test.ts(直接把 llm 设成暂停、走完整入站流水线,带对照)。
describe('e2e: 执行者探测一直失败时,不用模型的命令照常回', () => {
  it('after repeated first-use probe failures, commands that never call the model still answer', async () => {
    const daemon = await startTestDaemon({
      dangerously: true,
      access: { admins: ['owner'], allowFrom: ['owner'] },
      knownUsers: { owner: '主人' },
      claudeScript: { async onDispatch() { throw Object.assign(new Error('API Error: 529 overloaded'), { status: 529 }) } },
    })
    const out: Record<string, string> = {}
    try {
      let t = Date.now()
      const send = async (text: string) => {
        const before = daemon.ilink.outbox().filter(m => m.endpoint === 'sendmessage' && m.chatId === 'owner').length
        daemon.sendText('owner', text, { createTimeMs: (t += 1000) })
        const got = await daemon.waitForOutbound(ms => ms.filter(m => m.endpoint === 'sendmessage' && m.chatId === 'owner').length > before, 4000).catch(() => null)
        const fresh = (got ?? daemon.ilink.outbox()).filter(m => m.endpoint === 'sendmessage' && m.chatId === 'owner').slice(before).map(m => m.text ?? '').join(' | ')
        return fresh ? stable(fresh.replace(/\s+/g, ' ')).slice(0, 40) : '(没回)'
      }
      for (let i = 0; i < 4; i++) out[`聊天 ${i}`] = await send(`你好 ${i}`)
      for (const text of ['邀请码', '待批准', '定时', '日报', '/set', '/health']) out[text] = await send(text)
    } finally { await daemon.stop() }
    expect(out).toMatchSnapshot()
  }, 120_000)
})

// 评审(3b 接口):快照只有 knownUsers 三档的话,对 onboarding 的两条路是瞎的 —— 没见过的用户、起名阶段,
// onboarding 的 probe 对这两种状态下的每一句都认(onboarding.ts)。3b 搬 onboarding 进命令表时对的就是这份。
// 起名阶段发 /cli:3a 之后一度被 onboarding 当成名字(回「昵称只支持…」);3b 把命令声明的 /词(ownsSlash)排在 mode 之前,现在列终端会话。
// 起名阶段发 /cc 仍归 mode(mode 排在 onboarding 之前),普通一句仍是名字。
describe('e2e: 没见过的主人走一遍上手(起名阶段里的命令)', () => {
  it('nickname → bot name, with slash commands sent in between', async () => {
    const daemon = await startTestDaemon({
      dangerously: true,
      access: { admins: ['fresh'], allowFrom: ['fresh'] },
      knownUsers: {},
      claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'AGENT' } } },
    })
    const out: Array<[string, string]> = []
    try {
      let t = Date.now()
      for (const text of ['你好', '/cc', '小明', '/cc', '/cli', '小C', '你好']) {
        const before = daemon.ilink.outbox().filter(m => m.endpoint === 'sendmessage' && m.chatId === 'fresh').length
        daemon.sendText('fresh', text, { createTimeMs: (t += 1000) })
        const got = await daemon.waitForOutbound(ms => ms.filter(m => m.endpoint === 'sendmessage' && m.chatId === 'fresh').length > before, 3000).catch(() => null)
        await new Promise(r => setTimeout(r, 300))   // 一句可能回好几条(欢迎 + 问名字),都收进来
        const fresh = (got ? daemon.ilink.outbox() : daemon.ilink.outbox()).filter(m => m.endpoint === 'sendmessage' && m.chatId === 'fresh').slice(before).map(m => m.text ?? '').join(' | ')
        out.push([text, fresh ? stable(fresh.replace(/\s+/g, ' ')).slice(0, 60) : '(没回)'])
      }
    } finally { await daemon.stop() }
    expect(out).toMatchSnapshot()
  }, 120_000)
})
