/**
 * mw-task-reference — 管家:主人用自然语言说某件事,CC 找到是哪个任务,然后去做。
 *
 * 不新造语义:落定之后翻译成已有的规范命令(「任务 <id> 补充 …」「任务 <id> 停止」
 * 「任务 <id>」「任务 <id> 结果」),走同一个 handleWechat —— 去重键、回执、回复格式
 * 全部复用。这里只负责三件事:管家头(项目 · 标题 · 执行者 · 状态,也是下次引用的锚)、
 * 声明式焦点(20 分钟)、落不定时列选项问一句。落不定且无焦点 ⇒ next(),普通聊天照旧。
 *
 * 位置:在 transcribe-voice 之后(语音先转文字)、recall 之前(被消费的消息不付嵌入成本)。
 */
import type { Middleware } from './types'
import { isWechatTaskCommand, type WechatMessageIdentity, type WechatWorkbenchReply } from '../../core/workbench/wechat-control'
import { resolveTaskReference, FOCUS_TTL_MS, type TaskCandidate, type TaskJudge, type FocusState } from '../../core/workbench/task-reference'

export interface TaskReferenceMwDeps {
  ownerChatId(): string | null
  /** 活跃候选(进行中 / 已答复 / 排队),按 chat 给。 */
  candidates(chatId: string): TaskCandidate[]
  handleWechat(chatId: string, text: string, identity?: WechatMessageIdentity): Promise<WechatWorkbenchReply | null>
  sendMessage(chatId: string, text: string): Promise<unknown>
  judge?: TaskJudge
  now?(): number
  log(tag: string, line: string): void
}

const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', openai: 'API', cursor: 'Cursor', agy: 'agy' }
const PHASE_NAME: Record<string, string> = { queued: '排队中', working: '进行中', replied: '已答复', failed: '需要处理', cancelled: '已停止', interrupted: '已中断' }
const STOP_VERB = /(停止|结束|取消|别做了|不用做了)\s*[。.!！]?$/
const RESULT_VERB = /(结果|成果|文件|下载)/
const STATUS_VERB = /(怎么样|怎样|进展|状态|做完了吗|好了吗|完成了吗|查看|看看|到哪了)/
const BARE_CHOICE = /^\s*(\d{1,2})\s*[.。)]?\s*$/
/** "你说的是哪一件"的作答窗口。真机 2026-09-16:主人 8 分钟后才回「2」,5 分钟窗口已过,那个「2」被当成了补充。 */
const CHOICE_TTL_MS = 30 * 60_000

export const header = (c: TaskCandidate) => `📁 ${c.project} · ${c.title} · ${PROVIDER_NAME[c.providerId] ?? c.providerId} · ${PHASE_NAME[c.phase] ?? c.phase}`
const option = (c: TaskCandidate) => `📁 ${c.project} · ${c.title}（${PROVIDER_NAME[c.providerId] ?? c.providerId}，${PHASE_NAME[c.phase] ?? c.phase}）`

function command(taskId: string, text: string): string {
  const t = text.trim()
  if (STOP_VERB.test(t)) return `任务 ${taskId} 停止`
  if (RESULT_VERB.test(t)) return `任务 ${taskId} 结果`
  if (STATUS_VERB.test(t)) return `任务 ${taskId}`
  return `任务 ${taskId} 补充 ${t}`
}

export function makeMwTaskReference(deps: TaskReferenceMwDeps): Middleware {
  const now = deps.now ?? Date.now
  const focus = new Map<string, FocusState>()
  const pending = new Map<string, { options: TaskCandidate[]; text: string; expiresAt: number }>()
  /** 主人从微信点过名的任务:第一次顺手开提醒(每进程每件一次),失败/完成才到得了手机。 */
  const watched = new Set<string>()

  const currentFocus = (chatId: string): FocusState | null => {
    const f = focus.get(chatId)
    if (!f) return null
    if (f.expiresAt <= now()) { focus.delete(chatId); return null }
    return f
  }
  /** 设焦点;返回是否是"新的"(此前没有或指向别件)—— 只在那时回显一句。 */
  const setFocus = (chatId: string, taskId: string): boolean => {
    const prev = currentFocus(chatId)
    focus.set(chatId, { taskId, expiresAt: now() + FOCUS_TTL_MS })
    return !prev || prev.taskId !== taskId
  }

  return async (ctx, next) => {
    const msg = ctx.msg
    const text = (msg.text ?? '').trim()
    const owner = deps.ownerChatId()
    if (!owner || msg.chatId !== owner || !text || isWechatTaskCommand(text)) { await next(); return }

    const candidates = deps.candidates(msg.chatId)
    if (!candidates.length) { await next(); return }
    const identity: WechatMessageIdentity = { accountId: msg.accountId, userId: msg.userId, msgId: msg.msgId, createTimeMs: msg.createTimeMs }

    // 上一句问了"哪一件",这句回了个数字。
    const ask = pending.get(msg.chatId)
    const choice = ask && ask.expiresAt > now() ? BARE_CHOICE.exec(text) : null
    let picked: TaskCandidate | null = null, effectiveText = text
    if (ask && choice) {
      const idx = Number(choice[1]) - 1
      pending.delete(msg.chatId)
      if (idx >= 0 && idx < ask.options.length) { picked = ask.options[idx]!; effectiveText = ask.text }
    } else if (BARE_CHOICE.test(text)) {
      // 一个裸数字不是任何任务的要求。没有待选问题就说一声,绝不变成"补充 2"送给执行者
      // (真机 2026-09-16:正是这样把 Codex 的一轮额度烧在了一个「2」上)。
      pending.delete(msg.chatId)
      ctx.consumedBy = 'workbench'
      await deps.sendMessage(msg.chatId, '现在没有待选的问题了。你指的是哪件事？说项目名或标题就行。')
      return
    }

    if (!picked) {
      const r = await resolveTaskReference({ text, quotedText: msg.quote?.text ?? null, focus: currentFocus(msg.chatId), nowMs: now(), candidates, judge: deps.judge })
      if (r.kind === 'none') { await next(); return }
      ctx.consumedBy = 'workbench'
      if (r.kind === 'ambiguous') {
        pending.set(msg.chatId, { options: r.options, text, expiresAt: now() + CHOICE_TTL_MS })
        await deps.sendMessage(msg.chatId, '你说的是哪一件？\n' + r.options.map((c, i) => `${i + 1}. ${option(c)}`).join('\n') + '\n回数字选择。')
        return
      }
      if (r.kind === 'set_focus') {
        const c = candidates.find(x => x.id === r.taskId)!
        setFocus(msg.chatId, c.id)
        await deps.sendMessage(msg.chatId, `好，接下来默认说「📁 ${c.project} · ${c.title}」（20 分钟内）。`)
        return
      }
      picked = candidates.find(x => x.id === r.taskId)!
    }
    ctx.consumedBy = 'workbench'

    const cmd = command(picked.id, effectiveText)
    const fresh = setFocus(msg.chatId, picked.id)
    if (!watched.has(picked.id)) {
      watched.add(picked.id)
      try { await deps.handleWechat(msg.chatId, `任务 ${picked.id} 提醒我`, identity) } catch { /* 提醒开不开不挡主要动作 */ }
    }
    const reply = await deps.handleWechat(msg.chatId, cmd, identity)
    if (reply !== null && typeof reply === 'object') return
    const body = reply ?? '任务控制仅对已绑定的主人开放。'
    const lines = [header(picked), body]
    if (fresh) lines.push('（接下来默认说这件，20 分钟内。）')
    deps.log('WORKBENCH', `task reference → ${cmd.slice(0, 60)}`)
    const sent = await deps.sendMessage(msg.chatId, lines.join('\n'))
    if (sent && typeof sent === 'object' && 'error' in sent && (sent as { error?: unknown }).error) throw Error('workbench_reply_failed')
  }
}
