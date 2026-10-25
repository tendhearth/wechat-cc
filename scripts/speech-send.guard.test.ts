/**
 * CC 开口只有一道门(第三批 3a,设计稿 docs/superpowers/specs/2026-10-21-speech-policy-design.md)—— 守卫先上,按违规计数。
 *
 * 2026-10-21 盘点:src 里调用发送原语的地方有 36 处会在没人问的时候开口,各判各的闸。一次迁不完,所以守卫先上:
 * 下面每个文件标一类、记现在的调用次数。规矩:
 *  - **没登记的文件出现发送调用 ⇒ 红**:新的主动开口一律走 `policy.say`(daemon/speech/policy.ts)。
 *  - **登记过的文件次数只许降**:多一处 ⇒ 红;少了也红,提示你把数字调下来(棘轮,不让迁走的位置被悄悄补回去)。
 *  - 只有两类,长期留着:'primitive' 是发送本身(定义 / 接线 / 投递出口);'reply' 是回答对方刚发来的那一句,
 *    或者主人当面点的操作(发给谁也是主人定的)—— 都不属于主动开口。
 *  - **没有过渡态**:2026-10-22 盘点的 36 处全部迁完,'migrate' 这一类删了。新的主动开口一律走 `policy.say` / `policy.tell`,
 *    不许先登记个「以后再迁」(整合者评审)。
 * 数的是调用,不是行数(复查 10-21 理念 5:数违规,不数症状)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 发送原语 = IlinkAdapter 上所有 send* 方法(sendTyping 除外,它不说话)+ 其余几层包装。ilink 那一份从类型里读,不手写:
// ilink 以后加 sendVoice 这类方法,守卫自动管到(整合者评审 #513)。
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

type Tag = 'primitive' | 'reply'
const BASELINE: Record<string, [Tag, number]> = {
  // —— 发送本身 ——
  'src/daemon/ilink-glue.ts': ['primitive', 12],
  'src/daemon/companion/proactive-channel.ts': ['primitive', 5],
  'src/daemon/companion/app-channel.ts': ['primitive', 1],
  'src/daemon/internal-api/types.ts': ['primitive', 1],
  'src/lib/send-reply.ts': ['primitive', 1],
  'src/daemon/bootstrap/wire-coordinator.ts': ['primitive', 1],
  'src/daemon/bootstrap/fallback-reply.ts': ['primitive', 1],
  'src/app/coordinator/types.ts': ['primitive', 1],   // 只是 deps 注释里提到 sendAssistantText( —— 搬家前在 conversation-coordinator.ts
  'src/daemon/inbound/reply-scope.ts': ['primitive', 1],
  // 信自己的一套投递(多页、断了续发、App 那条路)。能不能写 / 寄已经走 policy.say(第三批 3a),发送只在 say 的生产者里。
  'src/features/letters/runtime.ts': ['primitive', 2],
  'src/features/letters/wire.ts': ['primitive', 1],
  // 社交那几条通知:判定走 policy.say(social-tell.ts,经 sendAssistantText 发 —— 它管 App 回话截获与旁听,不换);
  // 剩下这一处是明信片的 sendFile,也只在 say 的生产者里。
  'src/features/social/wire-social.ts': ['primitive', 1],   // 社交搬进 src/features/social(架构终态 A5),数没变
  // 工作台的微信通知:判定走 policy.say(批准 / 提问 = permission_ask,做完 / 失败 = matter_report);剩下这一处是工作台
  // 自己的严格发送口(幂等 client_id + 绑定核对 + 回执),只在 say 的生产者里、经 turn.sendTextWith 当微信那条腿。
  'src/daemon/bootstrap/wire-workbench-notifications.ts': ['primitive', 1],
  // App 原生推送:fanoutPush 的定义(phone-notifier)和唯一的调用(wire-phone)。用它的三处 —— App 主动通道(只在 say 那一轮
  // 收尾时推)、工作台通知推送(phone-notifier)、终端会话推送(appPush)—— 后两处先过 speech/push-gate.ts 问门(policy.ask)。
  'src/features/phone/phone-notifier.ts': ['primitive', 1],   // 手机搬进 src/features/phone(架构终态 A5),数没变
  'src/daemon/wiring/wire-phone.ts': ['primitive', 1],
  // daemon-modules.ts(以前在 main.ts)剩下的全是接线:回复交付、命令回话、信自己的投递、internal-api 的回话出口、贴纸路由的发文件口(主动开口都已经走门,10-21)
  // 7:微信「终端 / @码」那条命令的回话出口(scopedSend 包着的 sendMessage)跟着终端会话搬进 src/features/terminal/wire.ts(架构终态 A5),
  // 从这里减一、在下面 'reply' 那一组加一行,总数不变
  'src/daemon/daemon-modules.ts': ['primitive', 7],
  // pipeline-deps 剩下的全是接线:回话出口、proactive 的微信出口(发字 / 发文件)、给访客的回话、llm-health 的回话;访客申请已走门(10-21)
  'src/daemon/wiring/pipeline-deps.ts': ['primitive', 6],
  // —— 回答对方刚发来的那一句 ——
  'src/daemon/admin-commands.ts': ['reply', 70], // +1 2026-10-23「放行规则关掉 / 打开」:回主人当面那一句
  'src/daemon/onboarding.ts': ['reply', 16],
  'src/daemon/inbound/mw-task-reference.ts': ['reply', 11],
  'src/daemon/mode-commands.ts': ['reply', 2],
  'src/daemon/inbound/mw-llm-health.ts': ['reply', 2],
  'src/daemon/commands/task-command.ts': ['reply', 2],
  'src/features/terminal/reply-handler.ts': ['reply', 1],
  // 主人发的「终端」「看 码」「@码 …」的回话(命令在 src/features/terminal/wire.ts 里造,搬家前在 daemon-modules.ts 的 owner-commands)
  'src/features/terminal/wire.ts': ['reply', 1],
  'src/daemon/internal-api/routes-turn.ts': ['reply', 1],
  'src/daemon/inbound/mw-access.ts': ['reply', 2],     // 回访客刚发来的那一句(欢迎语 / 中性回话);告诉主人的那句已走门
  // 主人当面点的操作(广播),发给谁也是主人定的;以及回复那一轮里模型调的发文件 / 发表情。
  // 都不是 CC 主动开口 —— 别照这个口子把真正主动的东西塞进来(整合者评审)。
  'src/daemon/internal-api/routes.ts': ['reply', 1],
  // 桌面「分享这幅画」:主人当面点的,只发给 companion.default_chat_id(画室搬进 src/features/atelier 时从上面那一行挪过来;
  // 发图那一处原来就数,背景说明以前经 internal-api 的 ilink.sendReply 包装发、不数,现在直接 sendMessage,所以是 2)
  'src/features/atelier/routes.ts': ['reply', 2],
  // 同上:回复那一轮里模型调的发表情(本地 / 联网 / 候选),功能目录 src/features/stickers(架构终态 A5,从 routes.ts 搬来)
  'src/features/stickers/routes.ts': ['reply', 5],   // 四处发 + deps 接口里那一行 sendFile(
  // 主人发的命令的回话:「定时 …」「做过的事 …」
  'src/features/jobs/wire.ts': ['reply', 1],
  'src/daemon/bootstrap/wire-activity.ts': ['reply', 1],
  // 主人发的「日历 …」的回话(功能目录 src/features/calendar,架构终态 A4)
  'src/features/calendar/index.ts': ['reply', 1],
  // 主人回「允许 12」之后告诉访客「主人同意啦!」:主人当面的操作,发给谁也是主人定的
  'src/daemon/wiring/command-router.ts': ['reply', 1],
  // 主人刚发「任务 X 文件 <id>」点名要的那份成果:在处理这条命令时同步送、结果就是这条命令的回话;worker 没有定时 / 扫描,
  // 送不成也不自动重发(让主人重发命令)。回话不经门(设计稿「不改回复那条路」)。
  'src/daemon/bootstrap/wire-workbench-artifacts.ts': ['reply', 1],
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
  for (const d of ['src/daemon', 'src/features', 'src/app', 'src/domain', 'src/ports', 'src/adapters', 'src/core', 'src/lib']) {
    for (const f of walk(join(ROOT, d))) {
      const n = (readFileSync(f, 'utf8').match(SEND) ?? []).length
      if (n > 0) counts.set(relative(ROOT, f).split('\\').join('/'), n)
    }
  }
  it('没登记的文件不许直接发 —— 新的主动开口走 policy.say', () => {
    expect([...counts.keys()].filter(f => !(f in BASELINE))).toEqual([])
  })
  it('登记过的文件:多了红;少了也红(把 BASELINE 的数字调下来)', () => {
    const drift: string[] = []
    for (const [f, [tag, n]] of Object.entries(BASELINE)) {
      const now = counts.get(f) ?? 0
      if (now !== n) drift.push(`${f} [${tag}]: 登记 ${n},现在 ${now}`)
    }
    expect(drift).toEqual([])
  })
})
