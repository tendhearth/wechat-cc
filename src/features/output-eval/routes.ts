/**
 * 输出评测的路由(设计稿 docs/design/2026-10-29-output-eval.md):`wechat-cc eval run` 用 operator 凭据调,admin 档。
 *
 *   POST /v1/eval/run
 *     { kind: 'reply', text, tier?: 'admin'|'trusted', providerId?, model?, timeoutMs? }       → EvalTurnResult
 *     { kind: 'brief', material: BriefInputs, asks?: PickedAsk[], asksBase?, nowIso?, providerId?, model?, timeoutMs? } → EvalTurnResult
 *     { kind: 'reference', text, quotedText?, candidates: TaskCandidate[], focus?, nowMs? }      → EvalReferenceResult
 *     { kind: 'judge', prompt }                                                                → EvalJudgeResult(便宜模型原文)
 *
 * 跑了但没跑好(起不来、超时、模型报错)是 200 + `ok:false`(原因在 body 里,同 selftest/converse);
 * 请求本身不成立 ⇒ 400 eval_invalid_request(带 detail);执行者没注册 ⇒ 404 eval_unknown_provider;
 * 没有便宜模型 ⇒ 503 eval_no_cheap_model(码在 packages/protocol/src/workbench-errors.ts)。
 * 由 output-eval 模块自己挂(internalApi.mount);模块没起来时路由层回 module_*。
 */
import { workbenchErrorHttp } from '@wechat-cc/protocol'
import type { RouteTable } from '../../daemon/internal-api/types'
import type { PickedAsk } from '../../domain/owner-asks'
import type { BriefInputs } from '../jobs'
import type { TaskCandidate } from '../workbench'
import type { EvalRunner, ReplyInput, BriefInput, ReferenceInput } from './runner'

const PROVIDER_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/
const TEXT_MAX = 4000
const PROMPT_MAX = 20_000
const CANDIDATES_MAX = 50
const TIMEOUT_MAX_MS = 600_000

class Invalid extends Error {}
const fail = (detail: string): never => { throw new Invalid(detail) }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, name: string, max = TEXT_MAX): string => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail(`${name} 要是 1–${max} 字的字符串`))
const optStr = (v: unknown, name: string, max = 200): string | undefined => (v === undefined ? undefined : str(v, name, max))
const strList = (v: unknown, name: string): string[] => (v === undefined ? [] : Array.isArray(v) && v.every(x => typeof x === 'string') ? v as string[] : fail(`${name} 要是字符串数组`))
const optInt = (v: unknown, name: string, min: number, max: number): number | undefined =>
  v === undefined ? undefined : typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail(`${name} 要是 ${min}–${max} 的整数`)

function runOpts(b: Record<string, unknown>): Pick<ReplyInput, 'providerId' | 'model' | 'timeoutMs'> {
  const providerId = b.providerId === undefined ? undefined : typeof b.providerId === 'string' && PROVIDER_ID_RE.test(b.providerId) ? b.providerId : fail('providerId 不合法')
  const model = optStr(b.model, 'model')
  const timeoutMs = optInt(b.timeoutMs, 'timeoutMs', 1, TIMEOUT_MAX_MS)
  return { ...(providerId !== undefined ? { providerId } : {}), ...(model !== undefined ? { model } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
}

function replyInput(b: Record<string, unknown>): ReplyInput {
  const text = str(b.text, 'text')
  if (b.tier !== undefined && b.tier !== 'admin' && b.tier !== 'trusted') fail('tier 只能是 admin / trusted')
  return { text, ...(b.tier !== undefined ? { tier: b.tier as 'admin' | 'trusted' } : {}), ...runOpts(b) }
}

function briefInput(b: Record<string, unknown>): BriefInput {
  const m = isObj(b.material) ? b.material : fail('material 要是对象')
  const today = m.today === undefined || m.today === null ? null : str(m.today, 'material.today', 20_000)
  const calendar = m.calendar === undefined || m.calendar === null ? null : str(m.calendar, 'material.calendar', 20_000)
  const reminders = m.reminders === undefined ? [] : Array.isArray(m.reminders) && m.reminders.every(r => isObj(r) && typeof r.at === 'string' && typeof r.text === 'string')
    ? (m.reminders as Array<{ at: string; text: string }>).map(r => ({ at: r.at, text: r.text }))
    : fail('material.reminders 要是 [{ at, text }]')
  const material: BriefInputs = { today, reminders, agenda: strList(m.agenda, 'material.agenda'), prefs: strList(m.prefs, 'material.prefs'), calendar }
  let asks: PickedAsk[] | undefined
  if (b.asks !== undefined) {
    if (!Array.isArray(b.asks) || !b.asks.every(a => isObj(a) && typeof a.no === 'number' && ['id', 'hash', 'question', 'recommend'].every(k => typeof a[k] === 'string'))) fail('asks 要是 [{ no, id, hash, question, recommend }]')
    asks = (b.asks as PickedAsk[]).map(a => ({ no: a.no, id: a.id, hash: a.hash, question: a.question, recommend: a.recommend }))
  }
  const asksBase = optInt(b.asksBase, 'asksBase', 0, 100)
  const nowIso = optStr(b.nowIso, 'nowIso', 64)
  return { material, ...(asks ? { asks } : {}), ...(asksBase !== undefined ? { asksBase } : {}), ...(nowIso !== undefined ? { nowIso } : {}), ...runOpts(b) }
}

function referenceInput(b: Record<string, unknown>): ReferenceInput {
  const text = str(b.text, 'text')
  if (!Array.isArray(b.candidates) || b.candidates.length > CANDIDATES_MAX) fail(`candidates 要是不超过 ${CANDIDATES_MAX} 条的数组`)
  const candidates: TaskCandidate[] = (b.candidates as unknown[]).map((c, i) => {
    if (!isObj(c) || typeof c.id !== 'string' || typeof c.title !== 'string' || (c.project !== undefined && typeof c.project !== 'string')) fail(`candidates[${i}] 至少要有字符串的 id、title`)
    const o = c as Record<string, unknown>
    const s = (k: string) => (typeof o[k] === 'string' ? o[k] as string : '')
    return {
      id: o.id as string, title: o.title as string, project: s('project'), path: s('path'), providerId: s('providerId'), phase: s('phase'),
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
      ...(typeof o.error === 'string' ? { error: o.error } : {}),
    }
  })
  const quotedText = b.quotedText === undefined || b.quotedText === null ? undefined : str(b.quotedText, 'quotedText')
  let focus: ReferenceInput['focus']
  if (b.focus !== undefined && b.focus !== null) {
    if (!isObj(b.focus) || typeof b.focus.taskId !== 'string' || typeof b.focus.expiresAt !== 'number') fail('focus 要是 { taskId, expiresAt }')
    focus = { taskId: (b.focus as { taskId: string }).taskId, expiresAt: (b.focus as { expiresAt: number }).expiresAt }
  }
  const nowMs = b.nowMs === undefined ? undefined : typeof b.nowMs === 'number' && Number.isFinite(b.nowMs) ? b.nowMs : fail('nowMs 要是数字')
  return { text, candidates, ...(quotedText !== undefined ? { quotedText } : {}), ...(focus ? { focus } : {}), ...(nowMs !== undefined ? { nowMs } : {}) }
}

export function outputEvalRoutes(runner: EvalRunner): RouteTable {
  const refused = (code: string) => { const h = workbenchErrorHttp(code, 'desktop'); return { status: h.status, body: { ok: false, error: h.error } } }
  return {
    'POST /v1/eval/run': async (_q, body) => {
      let call: () => Promise<{ ok: boolean; code?: string } & object>
      try {
        const b = isObj(body) ? body : fail('body 要是 JSON 对象')
        switch (b.kind) {
          case 'reply': { const i = replyInput(b); call = () => runner.reply(i); break }
          case 'brief': { const i = briefInput(b); call = () => runner.brief(i); break }
          case 'reference': { const i = referenceInput(b); call = () => runner.reference(i); break }
          case 'judge': { const p = str(b.prompt, 'prompt', PROMPT_MAX); call = () => runner.judge(p); break }
          default: return fail('kind 只能是 reply / brief / reference / judge')
        }
      } catch (e) {
        if (e instanceof Invalid) { const h = workbenchErrorHttp('eval_invalid_request', 'desktop'); return { status: h.status, body: { ok: false, error: h.error, detail: e.message } } }
        throw e
      }
      const r = await call()
      if (r.ok === false && typeof r.code === 'string') return refused(r.code)
      return { status: 200, body: r }
    },
  }
}
