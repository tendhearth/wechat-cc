/**
 * 「CC 做过的事」的来源(B9,spec 2026-10-20-cc-activity-design):把各处已有记录 + 补记日志变成一行一句。
 * 只算 CC 替主人做的事、只算主人的;正文不搬(信只取开头,提醒的原文按 id 回原表读、只认主人)。
 * 每个来源各自 try / catch:抛了 ⇒ null(进 degraded),没接 ⇒ 不出现。
 */
import { CLI_SPECS } from '../core/cli-upgrade/specs'
import { activityTitle, type ActivityItem, type ActivitySources } from '../core/cc-activity'
import type { PermissionDecisionRow } from './permission-decisions-store'
import type { ActivityLogEntry } from './activity-log'
import { statusWord } from './scheduled-jobs/command'

const LETTER_OPENING_MAX = 24

export interface ActivitySourceDeps {
  now: () => number
  ownerChatId: () => string | null
  decisions?: () => PermissionDecisionRow[]
  tasks?: () => Array<{ id: string; title: string; status: string; updatedAt: number; ownerChatId: string | null }>
  terminal?: () => Array<{ session_id: string; status: string; project: string; last_event_at: number }>
  letters?: () => Array<{ id: string; sentAt: number; opening: string; via: string }>
  memoryLog?: () => Array<{ at: string; ops: Array<{ kind?: string }> }>
  log?: () => ActivityLogEntry[]
  jobs?: () => Array<{ id: string; text: string; brief?: boolean }>
  /** 提醒原文:只回主人那条对话里的(别人的 ⇒ null)。 */
  reminderText?: (id: string) => string | null
  cliUpgrades?: () => Array<{ cli: string; last: { from: string | null; to: string | null; at: string; result: string } | null }>
}

const item = (kind: ActivityItem['kind'], id: string, at: number, title: string, ref?: ActivityItem['ref']): ActivityItem =>
  ({ id: `${kind}:${id}`, kind, at, title: activityTitle(title), ...(ref ? { ref } : {}) })
const clipChars = (s: string, n: number) => { const a = [...s.trim()]; return a.length <= n ? a.join('') : a.slice(0, n).join('') + '…' }

export function collectActivity(deps: ActivitySourceDeps): ActivitySources {
  const owner = deps.ownerChatId()
  const safe = <T>(fn: (() => T) | undefined, map: (v: T) => ActivityItem[]): ActivityItem[] | null | undefined => {
    if (!fn) return undefined
    try { return map(fn()) } catch { return null }
  }
  const out: ActivitySources = {}
  const put = (k: keyof ActivitySources, v: ActivityItem[] | null | undefined) => { if (v !== undefined) out[k] = v }

  put('decisions', safe(deps.decisions, rows => rows.flatMap(r => {
    // 主人自己点的不算 CC 做的;规则 / CC 审过 / 红线 才算
    if (r.by === 'rule') return [item('decision', String(r.id), r.at, `按规则替你${r.verdict === 'allow' ? '批了' : '拒了'} ${r.tool}:${r.summary}${r.ruleId ? `(规则 ${r.ruleId})` : ''}`)]
    if (r.by === 'review') return [item('decision', String(r.id), r.at, `看过后替你${r.verdict === 'allow' ? '批了' : '拒了'} ${r.tool}:${r.summary}`)]
    if (r.by === 'floor') return [item('decision', String(r.id), r.at, `红线拦下了 ${r.tool}:${r.summary}`)]
    return []
  })))
  put('together', safe(deps.tasks, rows => !owner ? [] : rows.flatMap(t => {
    if (t.ownerChatId !== owner) return []
    const word = t.status === 'completed' ? '做完了' : t.status === 'failed' ? '没做成' : t.status === 'interrupted' ? '停在半路' : null
    return word ? [item('together', t.id, t.updatedAt, `一起做「${t.title}」${word}`, { type: 'task', id: t.id })] : []
  })))
  put('terminal', safe(deps.terminal, rows => rows.flatMap(s =>
    s.status === 'idle' || s.status === 'ended' ? [item('terminal', `${s.session_id}:${s.last_event_at}`, s.last_event_at, `终端 ${s.project} 这一轮做完了`, { type: 'terminal', id: s.session_id })] : [])))
  put('letters', safe(deps.letters, rows => rows.map(l => item('letter', l.id, l.sentAt, `给你寄了一封信:${clipChars(l.opening, LETTER_OPENING_MAX)}`, { type: 'letter', id: l.id }))))
  put('memory', safe(deps.memoryLog, rows => rows.flatMap(r => {
    const at = Date.parse(r.at)
    if (!Number.isFinite(at) || !Array.isArray(r.ops) || r.ops.length === 0) return []
    // memory-log.jsonl 里每一项是 AppliedOp:kind = add / update / remove / expire(过期也算删掉)
    const n = (...kinds: string[]) => r.ops.filter(o => kinds.includes(o?.kind ?? '')).length
    const parts = [n('add') && `新增 ${n('add')} 条`, n('update') && `改 ${n('update')} 条`, n('remove', 'expire') && `删 ${n('remove', 'expire')} 条`].filter(Boolean)
    return [item('memory', r.at, at, `整理了记忆:${parts.length ? parts.join('、') : `动了 ${r.ops.length} 处`}`)]
  })))
  put('log', safe(deps.log, rows => {
    const jobs = new Map((deps.jobs?.() ?? []).map(j => [j.id, j]))
    return rows.flatMap(e => {
      const id = `${e.at}:${e.ref ?? ''}`
      if (e.kind === 'proactive') return e.status === 'sent' ? [item('proactive', id, e.at, '主动跟你说了一句')] : e.status === 'deferred' ? [item('proactive', id, e.at, '想跟你说一句,没发出去')] : []
      if (e.kind === 'job') {
        const j = e.ref ? jobs.get(e.ref) : undefined
        const word = e.status === 'other' ? '没跑成' : statusWord(e.status)
        return [item('job', id, e.at, j?.brief ? `早报:${word}` : `定时 ${e.ref ?? ''}${j ? `「${clipChars(j.text, 30)}」` : ''}:${word}`)]
      }
      if (e.kind === 'reminder') {
        let text: string | null = null
        try { text = e.ref && deps.reminderText ? deps.reminderText(e.ref) : null } catch { text = null }
        return [item('reminder', id, e.at, text ? `提醒了你:${clipChars(text, 40)}` : '提醒了你一件事')]
      }
      return []
    })
  }))
  put('upgrades', safe(deps.cliUpgrades, rows => rows.flatMap(({ cli, last }) => {
    if (!last) return []
    const at = Date.parse(last.at)
    if (!Number.isFinite(at)) return []
    // 程序名(「Claude Code 升级到 …」)只有一处:cli-upgrade/specs 的 CLI_SPECS.label(不是执行者显示名,那个在 executor-facts)
    const name = (CLI_SPECS as Record<string, { label: string } | undefined>)[cli]?.label ?? cli
    const text = last.result === 'upgraded' ? `${name} 升级到 ${last.to},自检通过`
      : last.result === 'rolled_back' ? `${name} 升级到 ${last.to} 没过自检,退回了 ${last.from}`
      : last.result === 'unverified' ? `${name} 换到了 ${last.to},还没验过`
      : last.result === 'rollback_failed' ? `${name} 升级到 ${last.to} 没过自检,也没能退回,要你看一下`
      : null
    return text ? [{ ...item('cli_upgrade', `${cli}:${last.at}`, at, text) }] : []
  })))
  return out
}
