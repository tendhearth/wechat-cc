/**
 * 每晚记忆整理的运行时:15 分钟一次 tick(该跑就跑一次整理、再看看待发通知),
 * 「整理记忆」的立即运行,以及给微信(文本)与手机(结构)的只读视图。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_FILENAME, SECTIONS, parseDue, parseMemoryDoc, renderForPrompt, type Section } from './curated-doc'
import { MEMORY_LOG_FILE, ownerMemoryRoot, readNightlyState, runMemoryNightly, writeNightlyState, type NightlyRunDeps } from './nightly'
import type { NightlyRunResult } from './nightly-notify'
import type { AppliedOp } from './nightly-ops'
import { localParts, noticeTiming } from './nightly-schedule'

export interface NoticeDeps {
  careGate(chatId: string, nowIso: string): { ok: true } | { ok: false; reason: string }
  claim(chatId: string, nowIso: string): void
  wechatSuspended(): boolean
  send(chatId: string, text: string): Promise<{ error?: string }>
}
export interface CuratedView {
  updated_at: string | null
  sections: Array<{ name: Section; items: Array<{ id: string | null; text: string; due: string | null; changed: boolean }> }>
}
export interface MemoryNightlyRuntime {
  tick(): Promise<void>
  runNow(): Promise<NightlyRunResult>
  readCurated(): string | null
  curatedView(): CuratedView | null
}

const CHANGED_WINDOW_MS = 36 * 3_600_000

export async function deliverPendingNotice(deps: NightlyRunDeps & NoticeDeps): Promise<'none' | 'sent' | 'waiting' | 'expired' | 'dropped'> {
  const state = readNightlyState(deps.stateDir)
  const pending = state.pendingNotice
  const owner = deps.ownerChatId()
  if (!pending || !owner) return 'none'
  const nowMs = deps.now()
  const clear = () => writeNightlyState(deps.stateDir, { ...readNightlyState(deps.stateDir), pendingNotice: null })
  const timing = noticeTiming({ nowMs, tz: deps.config().timezone, createdAtMs: pending.createdAtMs })
  if (timing === 'expire') { clear(); deps.log('MEMORY_NIGHTLY', 'notice expired unsent'); return 'expired' }
  if (timing === 'wait' || deps.wechatSuspended()) return 'waiting'
  const nowIso = new Date(nowMs).toISOString()
  const gate = deps.careGate(owner, nowIso)
  if (!gate.ok) {
    if (gate.reason === 'memory_cooldown') return 'waiting'
    clear()
    deps.log('MEMORY_NIGHTLY', `notice dropped: ${gate.reason}`)
    return 'dropped'
  }
  deps.claim(owner, nowIso)   // 先登记再发:至多一次,不重试轰炸
  clear()
  const r = await deps.send(owner, pending.text)
  if (r.error) deps.log('MEMORY_NIGHTLY', `notice send failed (not retried): ${r.error}`)
  return 'sent'
}

function lastLog(root: string): { at: string; ops: AppliedOp[] } | null {
  const p = join(root, MEMORY_LOG_FILE)
  if (!existsSync(p)) return null
  const lines = readFileSync(p, 'utf8').trim().split('\n')
  try { return JSON.parse(lines[lines.length - 1]!) as { at: string; ops: AppliedOp[] } } catch { return null }
}

export function makeMemoryNightlyRuntime(deps: NightlyRunDeps & NoticeDeps): MemoryNightlyRuntime {
  const root = (): string | null => {
    const owner = deps.ownerChatId()
    return owner ? ownerMemoryRoot(deps.stateDir, owner) : null
  }
  const readDoc = () => {
    const r = root()
    const p = r ? join(r, MEMORY_FILENAME) : null
    return r && p && existsSync(p) ? { root: r, doc: parseMemoryDoc(readFileSync(p, 'utf8')) } : null
  }
  // tick() and runNow() (CLI, /v1/memory/nightly/run, 微信「整理记忆」) share
  // one chain: a call waits for any in-flight run, so this process never has
  // two runMemoryNightly in parallel (they'd race on memory.md and state).
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }
  // A skip reason like disabled / failed_today would otherwise log every
  // 15-min tick (~96 lines/day). Log it only when it changes.
  let lastSkipReason: string | null = null
  return {
    tick: () => serial(async () => {
      const r = await runMemoryNightly(deps, { force: false })
      if (r.status === 'skipped') {
        if (r.reason !== 'not_due' && r.reason !== lastSkipReason) deps.log('MEMORY_NIGHTLY', `tick: skipped (${r.reason})`)
        lastSkipReason = r.reason
      } else {
        lastSkipReason = null
        deps.log('MEMORY_NIGHTLY', `tick: ${r.status}${r.status === 'written' ? '' : ` (${r.reason})`}`)
      }
      await deliverPendingNotice(deps)
    }),
    runNow: () => serial(() => runMemoryNightly(deps, { force: true })),
    readCurated() {
      const got = readDoc()
      if (!got) return null
      const state = readNightlyState(deps.stateDir)
      const log = lastLog(got.root)
      const changes = log ? log.ops.length : 0
      const when = state.lastRunIso ? localParts(Date.parse(state.lastRunIso), deps.config().timezone) : null
      const header = state.failures >= 3
        ? `⚠️ 最近 ${state.failures} 次整理都没成功,下面可能是旧的。`
        : `最近整理:${when ? `${when.day} ${when.hhmm}` : '还没有'} · 改了 ${changes} 处`
      return `${header}\n\n${renderForPrompt(got.doc)}`
    },
    curatedView() {
      const got = readDoc()
      if (!got) return null
      const log = lastLog(got.root)
      const fresh = log && deps.now() - Date.parse(log.at) < CHANGED_WINDOW_MS
      const changed = new Set(fresh ? log!.ops.filter(o => o.kind === 'add' || o.kind === 'update').map(o => o.id) : [])
      return {
        updated_at: readNightlyState(deps.stateDir).lastRunIso,
        sections: SECTIONS.map(name => ({
          name,
          items: got.doc.sections[name].map(e => ({ id: e.id, text: e.text, due: parseDue(e.text), changed: !!e.id && changed.has(e.id) })),
        })),
      }
    },
  }
}
