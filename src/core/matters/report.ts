import type {Matter} from './store'

/**
 * matters/report.ts — 每轮答复该不该回原对话、回什么。
 *
 * 纯逻辑面(不碰网络、不碰 db):只回答「这一轮的回报文本是什么」。判据就是
 * 出生地本身——`matter.originMatterId`(那次交办它的聊天,本身是一行
 * kind='chat' 的 matter)是不是 null。桌面上亲手派的事两者皆 null,「没有
 * 出生地 ⇒ 不回报」不是另设的开关,就是这一条判据(设计见 v64 迁移注释)。
 * 投递(找 chat、发消息、退避重试)在 daemon 侧的 outbox/sweeper,见
 * src/daemon/reports/。
 * 设计:.superpowers/sdd/2026-09-23-delegation-report/task-3-brief.md。
 */

export interface PendingReport {
  matterId: string
  originMatterId: string
  originMessageId: string | null
  text: string
}

/**
 * 纯函数:这一轮该不该报、报什么。没有出生地 ⇒ null。只管**内容**,不管
 * 「现在方不方便打扰人」(那是 shouldDisturb 的事,Task 4)。
 *
 * 文案模板:
 *   <标题> · 已答复。<成果句>
 *   看:任务 <id> · 接着说:任务 <id> 补充 …
 * 成果句:artifactCount===0 时省略;>0 时「累计生成了 N 份成果。」。用现成的
 * 「任务」指称动词(见微信管家指称解析),不造新命令。
 *
 * `artifactCount` 是调用方给的**累计**成果数(不是这一轮新增的),文案里写
 * 明「累计」二字(评审修复轮 1 ④ Minor):一件事跨多轮答复,数字会一路涨,
 * 不写清楚容易被读成「这次生成了 N 份」这种一轮内的成果,像 bug。算清楚
 * 「这一轮新增了几份」需要在 Active 上另存一个回合起点的基线并在每个回合
 * 边界重置,拿这份复杂度换一个措辞上的精确度不值——文案说清楚累计口径更
 * 便宜也更不容易出新 bug。
 *
 * `turn` 是这一轮的 `Active.turnSeq`(终审第 6 项):相邻两轮没有新成果
 * (`artifactCount` 没变)时,以前 `outcome` 是空字符串,两条文案逐字节相
 * 同——主人分不清指的是哪一轮,而且重复外发相同文本正是本仓库别处(reminders
 * 那条退避)专门要躲开的微信风控触发形状。轮次本来就是现成的(去重键就
 * 是它),塞进文案里,相邻两轮至少「第 N 轮」这几个字不一样。
 *
 * **但 `turn` 对非 retained 执行者(agy/cursor-ACP/openai/gemini)基本等
 * 于没修**(终审后修复第二轮③,记账明确写下来,别让下一个人以为轮次号
 * 在所有执行者上都有效):`turnSeq` 只在有 `workbenchRuntime` 的执行者
 * 身上推进(workbench/service.ts 的 `submitInput`/转移探测器那两处
 * `turnSeq++`);其余执行者走纯 `dispatch`,而且**每一轮都是新的
 * `Active`**(初值 0)——它们永远是 `turn===0`,「第 1 轮」这几个字在相
 * 邻两轮之间不会变,单靠这个字段区分不开。这类执行者真正的可区分性来自
 * `body`(见下面,通常每轮内容不同,终审后修复第二轮 Important②b 并进
 * 来的那段答复正文)。
 *
 * `body`(终审后修复第二轮 Important②b):非 retained 执行者 completed
 * 终态时,workbench/service.ts 会把 `stageFinishedNotice` 原本会发的通
 * 知正文(这一轮最后一条文本回复 + 保存的成果文件名)并进来——那条通知
 * 因为跟这次回报同一拍触发、内容重叠而被压掉了,正文不能跟着一起丢,否
 * 则主人这一轮的答案就只剩"看:任务 X",必须自己再问一句才能看到内
 * 容,而"交给 CC 之后能放心离开、回来接得上"正是这整个功能存在的理由。
 * retained 执行者的报(`settleQuiet` 那条路)没有通知被压,不传这个参
 * 数。
 */
export function renderReport(input: {matter: Matter; title: string; artifactCount: number; turn: number; body?: string}): PendingReport | null {
  const {matter, title, artifactCount, turn, body} = input
  if (!matter.originMatterId) return null
  const outcome = artifactCount > 0 ? `累计生成了${artifactCount}份成果。` : ''
  const bodyBlock = body ? `\n\n${body}` : ''
  const text = `${title} · 已答复（第 ${turn + 1} 轮）。${outcome}${bodyBlock}\n看:任务 ${matter.id} · 接着说:任务 ${matter.id} 补充 …`
  return {matterId: matter.id, originMatterId: matter.originMatterId, originMessageId: matter.originMessageId, text}
}

/**
 * 纯函数:这一轮该不该去微信打扰主人(Task 4,降噪)。只管**打扰**,不管回报
 * 内容本身(那是 renderReport 的事,上面)。调用点在投递循环的发送分支里,
 * 不在入队处——入队(生成回报)每轮都该发生、都该在原对话留痕;打扰与否要
 * 看人此刻在哪,是发送前最后一道闸,跟"要不要生成回报"是两件事。挡住 ≠
 * 发送失败:投递器不得因为这道闸把行标记失败、写 first_fail_at 或套用失败
 * 退避——那样降噪就变成了丢投递。挡住的行原样留在 pending,下一拍再看。
 *
 * 临时判据(2026-09-23):spec 要的信号是"这件事的详情正被人看着",而今天
 * matter_bindings.last_seen_at 只在绑定时写(微信入站那下),详情读取不留痕。
 * 所以这道闸会把"人刚在微信里说过话"误判成"人正在看这件事"——是一道粗闸,
 * 明确标临时。收紧的条件:手机 /m/api/matter 与桌面长轮询开始写 viewed_at
 * 之后换判据。
 */
export const VIEWED_RECENTLY_MS = 60_000

export function shouldDisturb(input: {lastSeenAt: number | null; now: number}): boolean {
  if (input.lastSeenAt === null) return true
  return input.now - input.lastSeenAt >= VIEWED_RECENTLY_MS
}

/**
 * service 侧的可选依赖,注入便于测试;不注入就整条功能不存在(降级路径,
 * 与 opts.matters/opts.log 同一套「可选依赖」约定)。真正的实现(daemon 侧
 * 的 makeReportSink,src/daemon/reports/report-sink.ts)在入队时调用
 * renderReport,把结果写进 matter_report_outbox(v65)等投递器去发。
 */
export interface ReportSink {
  /**
   * `turn` 是这一轮的 `Active.turnSeq`;`body`(可选)是并进回报文案的
   * 答复正文——见 renderReport 的文档注释,两者都是用来让相邻两轮的回
   * 报文案能区分开、并保住非 retained 执行者被压掉的那条通知的正文。
   */
  enqueue(matterId: string, turn: number, body?: string): void
}
