/**
 * CC 开口只有一道门(第三批 3a,设计稿 docs/superpowers/specs/2026-10-21-speech-policy-design.md)—— 守卫先上,按违规计数。
 *
 * 2026-10-21 盘点:src 里调用发送原语的地方有 36 处会在没人问的时候开口,各判各的闸。一次迁不完,所以守卫先上:
 * 下面每个文件标一类、记现在的调用次数。规矩:
 *  - **没登记的文件出现发送调用 ⇒ 红**:新的主动开口一律走 `policy.say`(daemon/speech/policy.ts)。
 *  - **登记过的文件次数只许降**:多一处 ⇒ 红;少了也红,提示你把数字调下来(棘轮,不让迁走的位置被悄悄补回去)。
 *  - 'primitive' 是发送本身(定义 / 路由),'reply' 是回答对方刚发来的那一句(不属于主动开口),两类长期留着;
 *    'migrate' 是要迁进 policy.say 的,迁完这一行删掉。
 * 数的是调用,不是行数(复查 10-21 理念 5:数违规,不数症状)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 发送原语 = IlinkAdapter 上所有 send* 方法(sendTyping 除外,它不说话)+ 其余几层包装。ilink 那一份从类型里读,不手写:
// ilink 以后加 sendVoice 这类方法,守卫自动管到(9d 评审 #513)。
const NOT_SPEECH = new Set(['sendTyping'])
function ilinkSendMethods(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'daemon', 'ilink-glue.ts'), 'utf8')
  const body = /export interface IlinkAdapter \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? ''
  return [...new Set([...body.matchAll(/^\s+(send[A-Za-z]*)\??\(/gm)].map(m => m[1]!))].filter(n => !NOT_SPEECH.has(n))
}
/** 包在 ilink 外面的几层(回复兜底、伙伴通道、App 推送)。 */
const WRAPPERS = ['sendReplyOnce', 'sendWechat', 'sendAssistantText', 'fanoutPush', 'sendOnce']
const PRIMITIVES = [...ilinkSendMethods(), ...WRAPPERS]
const SEND = new RegExp(`\\b(?:${PRIMITIVES.join('|')})\\(`, 'g')

type Tag = 'primitive' | 'reply' | 'migrate'
const BASELINE: Record<string, [Tag, number]> = {
  // —— 发送本身 ——
  'src/daemon/ilink-glue.ts': ['primitive', 12],
  'src/daemon/companion/proactive-channel.ts': ['primitive', 5],
  'src/daemon/companion/app-channel.ts': ['primitive', 1],
  'src/daemon/internal-api/types.ts': ['primitive', 1],
  'src/lib/send-reply.ts': ['primitive', 1],
  'src/daemon/bootstrap/wire-coordinator.ts': ['primitive', 1],
  'src/daemon/bootstrap/fallback-reply.ts': ['primitive', 1],
  'src/core/conversation-coordinator.ts': ['primitive', 1],
  'src/daemon/inbound/reply-scope.ts': ['primitive', 1],
  // —— 回答对方刚发来的那一句 ——
  'src/daemon/admin-commands.ts': ['reply', 69],
  'src/daemon/onboarding.ts': ['reply', 16],
  'src/daemon/inbound/mw-task-reference.ts': ['reply', 11],
  'src/daemon/mode-commands.ts': ['reply', 2],
  'src/daemon/inbound/mw-llm-health.ts': ['reply', 2],
  'src/daemon/commands/task-command.ts': ['reply', 2],
  'src/daemon/cli-reply-handler.ts': ['reply', 1],
  'src/daemon/internal-api/routes-turn.ts': ['reply', 1],
  // —— 要迁进 policy.say 的(盘点见设计稿第 2 步) ——
  'src/daemon/main.ts': ['migrate', 15],                 // 提醒、回报、升级、开机降级汇总、重启 …
  'src/daemon/internal-api/routes.ts': ['migrate', 6],   // 画作分享、广播 …
  'src/daemon/wiring/pipeline-deps.ts': ['migrate', 6],  // 访客申请 …;其中 1 处是 proactive 的微信出口(say 背后的那条路,10-21 从 wiring/index.ts 搬来)
  'src/daemon/bootstrap/wire-social.ts': ['migrate', 5], // 来信、心愿、介绍、明信片
  'src/daemon/bootstrap/wire-jobs.ts': ['migrate', 3],   // 没审成的通知
  'src/daemon/bootstrap/wire-cli-sessions.ts': ['migrate', 3],
  'src/daemon/wiring/wire-phone.ts': ['migrate', 2],
  'src/daemon/self-change-glue.ts': ['migrate', 2],
  'src/daemon/phone-notifier.ts': ['migrate', 2],
  'src/daemon/letters/runtime.ts': ['migrate', 2],
  'src/daemon/inbound/mw-access.ts': ['migrate', 2],
  'src/daemon/wiring/command-router.ts': ['migrate', 1],
  'src/daemon/startup-sweeps.ts': ['migrate', 1],
  'src/daemon/bootstrap/wire-workbench-notifications.ts': ['migrate', 1],
  'src/daemon/bootstrap/wire-workbench-artifacts.ts': ['migrate', 1],
  'src/daemon/bootstrap/wire-letters.ts': ['migrate', 1],
  'src/daemon/bootstrap/wire-activity.ts': ['migrate', 1],
  'src/daemon/bootstrap/wire-a2a-server.ts': ['migrate', 1],
  'src/daemon/bootstrap/index.ts': ['migrate', 1],
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== '__e2e__' && name !== 'node_modules') walk(p, out) }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

describe('发送原语只在登记过的地方出现,次数只许降', () => {
  it('原语清单从 IlinkAdapter 读得出来(读不出来 ⇒ 守卫瞎了,先红)', () => {
    expect(ilinkSendMethods().sort()).toEqual(expect.arrayContaining(['sendFile', 'sendMessage']))
    expect(ilinkSendMethods()).not.toContain('sendTyping')
  })
  const counts = new Map<string, number>()
  for (const d of ['src/daemon', 'src/core', 'src/lib']) {
    for (const f of walk(join(ROOT, d))) {
      const n = (readFileSync(f, 'utf8').match(SEND) ?? []).length
      if (n > 0) counts.set(relative(ROOT, f).split('\\').join('/'), n)
    }
  }
  it('没登记的文件不许直接发 —— 新的主动开口走 policy.say', () => {
    expect([...counts.keys()].filter(f => !(f in BASELINE))).toEqual([])
  })
  it('登记过的文件:多了红;少了也红(把 BASELINE 的数字调下来,迁完的 migrate 行删掉)', () => {
    const drift: string[] = []
    for (const [f, [tag, n]] of Object.entries(BASELINE)) {
      const now = counts.get(f) ?? 0
      if (now !== n) drift.push(`${f} [${tag}]: 登记 ${n},现在 ${now}`)
    }
    expect(drift).toEqual([])
  })
})
