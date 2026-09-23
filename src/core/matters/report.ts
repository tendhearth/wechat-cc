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
 * 成果句:artifactCount===0 时省略;>0 时「生成了 N 份成果。」。用现成的
 * 「任务」指称动词(见微信管家指称解析),不造新命令。
 */
export function renderReport(input: {matter: Matter; title: string; artifactCount: number}): PendingReport | null {
  const {matter, title, artifactCount} = input
  if (!matter.originMatterId) return null
  const outcome = artifactCount > 0 ? `生成了${artifactCount}份成果。` : ''
  const text = `${title} · 已答复。${outcome}\n看:任务 ${matter.id} · 接着说:任务 ${matter.id} 补充 …`
  return {matterId: matter.id, originMatterId: matter.originMatterId, originMessageId: matter.originMessageId, text}
}

/**
 * service 侧的可选依赖,注入便于测试;不注入就整条功能不存在(降级路径,
 * 与 opts.matters/opts.log 同一套「可选依赖」约定)。真正的实现(daemon 侧
 * 的 makeReportSink,src/daemon/reports/report-sink.ts)在入队时调用
 * renderReport,把结果写进 matter_report_outbox(v65)等投递器去发。
 */
export interface ReportSink {
  enqueue(matterId: string): void
}
