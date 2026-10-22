/**
 * 额度恢复后接着做(spec 2026-10-20-quota-resume-design,对标 Claude Code auto-continue)。
 * 主人按件选了「等恢复」⇒ 排一次:恢复时刻 + 2 分钟到点,核对还是那个额度失败、主人期间没动过、没有在跑的 ⇒ continueTask 一次。
 * 只试一次:没接上就写事件 + 告诉主人一句,不重试。排程存 quota-resume.json(重启读回;错过 6 小时以上不补)。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../../lib/read-json-file'
import type { ServiceCtx } from './ctx'
import { writeFileAtomic } from '../../../lib/json-file'

export const QUOTA_RESUME_FILE = 'quota-resume.json'
export const QUOTA_RESUME_MARGIN_MS = 2 * 60_000
export const QUOTA_RESUME_MAX_AHEAD_MS = 24 * 3_600_000
export const QUOTA_RESUME_MISSED_MS = 6 * 3_600_000
const QUOTA_CODES = new Set(['provider_quota_exhausted', 'provider_rate_limited'])
export const QUOTA_RESUME_TEXT = '额度恢复了,接着刚才那件事做下去。先看一眼停在哪里,再接着改。'

interface Entry { at: number; requestedAt: number; provider: string }
type Timer = { cancel(): void }

export interface QuotaResumeOptions {
  setTimer?: (fn: () => void, ms: number) => Timer
  /** 测试用:没接上时告诉主人一句。缺省 ⇒ 走这件事已订阅的微信通知(同额度用完那条)。 */
  notify?: (text: string) => void
}

const derivedId = (taskId: string, requestedAt: number) => {
  const d = createHash('sha256').update(`quota-resume\0${taskId}\0${requestedAt}`).digest('hex').slice(0, 32)
  const s = `${d.slice(0, 12)}4${d.slice(13, 16)}8${d.slice(17, 32)}`
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

export function makeQuotaResumeDomain(ctx: ServiceCtx, opts: QuotaResumeOptions = {}) {
  const { store } = ctx
  const file = join(ctx.stateDir, QUOTA_RESUME_FILE)
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number): Timer => { const t = setTimeout(fn, Math.max(0, ms)); t.unref?.(); return { cancel: () => clearTimeout(t) } })
  const timers = new Map<string, Timer>()
  const read = (): Record<string, Entry> => { try { return existsSync(file) ? readJsonFile<Record<string, Entry>>(file) ?? {} : {} } catch { return {} } }
  const write = (all: Record<string, Entry>) => {
    try { writeFileAtomic(file, JSON.stringify(all) + '\n') }
    catch (err) { ctx.log?.('WORKBENCH_QUOTA_RESUME', `write failed: ${err instanceof Error ? err.message : err}`) }
  }
  const drop = (id: string) => { const all = read(); if (all[id]) { delete all[id]; write(all) } timers.get(id)?.cancel(); timers.delete(id) }
  const note = (id: string, text: string) => { try { store.addEvent(id, 'system', text); ctx.hub.touched(id) } catch { /* 记不上不影响 */ } }
  const hhmm = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

  /** 主人期间没动过、还是那个额度失败、没有在跑、没归档。 */
  function stillWaiting(id: string, e: Entry): boolean {
    let task
    try { task = store.get(id) } catch { return false }
    if (task.archivedAt !== null || task.status !== 'failed' || !QUOTA_CODES.has(task.error ?? '')) return false
    if (ctx.state.runsByTask.has(id)) return false
    return !store.events(id).some(ev => ev.kind === 'user' && ev.createdAt > e.requestedAt)
  }

  function fire(id: string) {
    timers.delete(id)
    const e = read()[id]
    if (!e) return
    drop(id)
    // Mac 睡着时计时器会晚到:晚太多就当错过了,不照续(评审 #435)
    if (ctx.now() - e.at > QUOTA_RESUME_MISSED_MS) { note(id, '额度恢复那会儿电脑没醒着,错过了,没有接着做。要接着做就再说一声。'); return }
    if (!stillWaiting(id, e)) {
      ctx.log?.('WORKBENCH_QUOTA_RESUME', `${id}: skipped (task changed meanwhile)`)
      // 写清为什么没续,免得主人以为 CC 忘了(评审 #435)
      note(id, '到点了,但这件事期间已经变了(你说过话、它又跑过,或者归档了),所以没有再接着做。')
      return
    }
    try {
      ctx.actions.deref('quota-resume').continueTask(id, QUOTA_RESUME_TEXT, { inputRequestId: derivedId(id, e.requestedAt) })
      note(id, '额度恢复了,按你说的接着做了(只试这一次)。')
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err)
      note(id, `到点了,但没接上(${code})。不会再自己试,要接着做就再说一声。`)
      try {
        const task = store.get(id)
        const text = `「${task.title.replace(/[\r\n]+/g, ' ')}」到点了,但没接上(${code})。不会再自己试,要接着做就回「任务 ${id}」再说一声。`
        if (opts.notify) opts.notify(text)
        else ctx.actions.deref('quota-resume').enqueueNotice?.(task, `quota-resume-${e.requestedAt}`, 'failed', text)
      } catch { /* 说不上只少一句 */ }
    }
  }
  function arm(id: string, at: number) {
    timers.get(id)?.cancel()
    timers.set(id, setTimer(() => fire(id), at - ctx.now()))
  }

  /** 主人选了「等恢复」。同一件再排 = 同一个。 */
  function request(id: string): { ok: true; at: number } | { ok: false; error: 'not_found' | 'not_quota_failure' | 'quota_reset_unknown' | 'quota_reset_too_far' } {
      let task
      try { task = store.get(id) } catch { return { ok: false, error: 'not_found' } }
      const existing = read()[id]
      if (existing) return { ok: true, at: existing.at }
      if (task.status !== 'failed' || !QUOTA_CODES.has(task.error ?? '') || task.archivedAt !== null) return { ok: false, error: 'not_quota_failure' }
      const q = ctx.actions.deref('quota-resume').quotaExhausted(task.providerId)
      if (!q) return { ok: false, error: 'quota_reset_unknown' }
      if (q.resetAt - ctx.now() > QUOTA_RESUME_MAX_AHEAD_MS) return { ok: false, error: 'quota_reset_too_far' }
      const at = q.resetAt + QUOTA_RESUME_MARGIN_MS
      note(id, `好,约 ${hhmm(at)} 额度恢复,到时候我接着做(只试一次)。`)
      const all = read(); all[id] = { at, requestedAt: ctx.now(), provider: task.providerId }; write(all)
      arm(id, at)
      return { ok: true, at }
  }
  const pending = (id: string): number | null => read()[id]?.at ?? null
  const domain = {
    request,
    cancel(id: string) { drop(id) },
    /** 开机读回:没到点 ⇒ 重新计时;错过 ≤ 6 小时 ⇒ 现在试;更早 ⇒ 丢掉并记一条。 */
    recover() {
      const now = ctx.now()
      for (const [id, e] of Object.entries(read())) {
        if (e.at > now) { arm(id, e.at); continue }
        if (now - e.at <= QUOTA_RESUME_MISSED_MS) { arm(id, now); continue }
        drop(id)
        note(id, '额度恢复那会儿电脑没开着,错过了,没有接着做。要接着做就再说一声。')
      }
    },
    pending,
    shutdown() { for (const t of timers.values()) t.cancel(); timers.clear() },
    /** service 对外的那几个(主人按件选了「等恢复」⇒ 排一次;pending = 排在哪个时刻)。 */
    api: { quotaResume: request, quotaResumePending: pending, quotaResumeCancel: (id: string) => drop(id) },
  }
  return domain
}
export type QuotaResumeDomain = ReturnType<typeof makeQuotaResumeDomain>
