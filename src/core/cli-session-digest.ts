/**
 * cli-session-digest.ts — 终端会话登记处的「一眼看完」纯文本(2026-10-14)。
 *
 * 两个出口用同一份措辞:微信里主人发「终端」(daemon/cli-reply-handler.ts),和 CC 自己的
 * 只读工具 `terminal_sessions`(主人用大白话问「我终端里那几个在干嘛」)。微信不认 markdown,
 * 所以这里只出纯文本:等你批准的在最前、能在微信里拍的带上怎么回,其余按最近事件倒序,
 * 最多 CLI_DIGEST_MAX_ROWS 条。
 *
 * 纯函数:不碰库、不碰微信。输入是登记处的视图(状态已按 stale 折算、等你批准的已排在前)。
 */
import type { CliSessionView } from './cli-session-store'

/** 一次最多列这么多条(微信一屏)。 */
export const CLI_DIGEST_MAX_ROWS = 8
/** 最后一句 / 待批摘要压成一行的长度上限。 */
const LINE_MAX = 60

/** 登记处视图 + 中继开出去的码(main.ts 补上;老调用方没有)。 */
export type CliDigestView = CliSessionView & {
  pending: (NonNullable<CliSessionView['pending']> & {
    /** 中继在微信里开的 5 位码;主人在场时终端自己问 ⇒ null。 */
    hash?: string | null
    /** 微信卡片上的两位数码(「y 07」);同一条待批的短写法。 */
    reply_code?: string | null
  }) | null
}

/**
 * 给等批准的那几条补上「在微信里怎么回」:中继开的 5 位码 + 微信卡片上的两位数码。
 * 主人在场时终端自己在问(中继没开码)⇒ 两个都是 null —— 只能回终端处理。读码出错同样当没有。
 */
export function withReplyRefs(
  views: readonly CliSessionView[],
  pendingHash: (sessionId: string) => string | null,
  codeOf: (hash: string) => string | null,
): CliDigestView[] {
  return views.map((v) => {
    if (!v.pending) return v
    let hash: string | null = null, code: string | null = null
    try { hash = pendingHash(v.session_id); code = hash ? codeOf(hash) : null } catch { hash = null; code = null }
    return { ...v, pending: { ...v.pending, hash, reply_code: code } }
  })
}

export function cliSourceLabel(source: CliSessionView['source']): string {
  return source === 'codex' ? 'Codex' : source === 'cursor' ? 'Cursor' : 'Claude Code'
}

/** 「刚刚 / 3 分钟前 / 2 小时前 / 昨天 / 5 天前」。 */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  return d === 1 ? '昨天' : `${d} 天前`
}

function oneLine(text: string, max = LINE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

/** 这条待批在微信里怎么回;没开码 ⇒ null。两位数码优先(手机数字键盘就能打)。 */
export function replyRefOf(v: CliDigestView): string | null {
  const p = v.pending
  if (!p) return null
  return p.reply_code || p.hash || null
}

function statusWord(v: CliDigestView): string {
  switch (v.status) {
    case 'waiting': return '等你批准'
    case 'running': return '在跑'
    case 'idle': return v.stale ? '没动静了' : '做完了'
    case 'ended': return '已结束'
  }
}

export interface CliDigestOptions {
  now: number
  /** daemon 所在机器;会话的 machine 与之不同 ⇒ 写「那边(机器名)」。 */
  localMachine?: string | undefined
  max?: number
}

/**
 * 主人发「终端」时回的那条。每条一行标题(状态 · 项目 · 哪家 · 码 · 多久前),
 * 下面最多一行细节:待批的是要批什么 + 怎么回;其余是最后一句。
 */
export function formatCliSessionDigest(views: readonly CliDigestView[], opts: CliDigestOptions): string {
  const live = views.filter(v => v.status !== 'ended')
  if (live.length === 0) {
    return '终端里现在没有会话。\n装好 hook 的 Claude Code / Codex 会话开起来就会出现在这里(电脑上跑 wechat-cc hook install)。'
  }
  const max = Math.max(1, opts.max ?? CLI_DIGEST_MAX_ROWS)
  const shown = live.slice(0, max)
  const waiting = live.filter(v => v.status === 'waiting').length
  const running = live.filter(v => v.status === 'running').length
  const counts = [waiting ? `${waiting} 个等你批准` : '', running ? `${running} 个在跑` : ''].filter(Boolean).join('、')
  const lines: string[] = [`终端里 ${live.length} 个会话${counts ? `(${counts})` : ''}:`]
  for (const v of shown) {
    const remote = v.machine && opts.localMachine && v.machine !== opts.localMachine ? ` · 那边(${v.machine})` : ''
    const icon = v.status === 'waiting' ? '✋' : v.status === 'running' ? '⏳' : '·'
    const when = v.status === 'waiting' && v.pending ? relativeTime(v.pending.since, opts.now) : relativeTime(v.last_event_at, opts.now)
    lines.push(`${icon} ${statusWord(v)} · ${v.project}${remote} · ${cliSourceLabel(v.source)} · 码 ${v.code} · ${when}`)
    if (v.status === 'waiting' && v.pending) {
      // hook 的 permission 事件只记了 tool='permission'(占位),那就只写摘要。
      const tool = v.pending.tool === 'permission' ? '' : v.pending.tool
      const what = [tool, v.pending.summary ?? ''].filter(Boolean).join(': ')
      if (what) lines.push(`   ${oneLine(what)}`)
      const ref = replyRefOf(v)
      lines.push(ref ? `   —— 回「y ${ref}」放行、「n ${ref}」拒绝` : '   —— 终端那边在问,回终端处理')
    } else if (v.last_summary) {
      lines.push(`   ${oneLine(v.last_summary)}`)
    }
  }
  if (live.length > shown.length) lines.push(`(还有 ${live.length - shown.length} 个没列出)`)
  lines.push('「看 码」看最近的对话,「@码 话」接着说一句')
  return lines.join('\n')
}
