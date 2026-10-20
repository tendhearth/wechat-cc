/**
 * 「CC 做过的事」的补记日志(B9,spec 2026-10-20-cc-activity-design):那些原本没留记录的动作(主动说话、定时运行、
 * 到点提醒、CLI 升级)在发生处写一行。规矩(wechat-cc-2a 10-20):
 * - 只记「发生了什么」+ 原表的 id,不记正文(要显示的字按 id 回原表读、只认主人);facts 只收短的标记(版本号之类)。
 * - 写是异步的,失败只进日志,不影响动作本身。
 * - 有上限:超过 ACTIVITY_LOG_MAX_LINES 行就留新的一半;14 天前的裁掉。读时坏行跳过。
 */
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ACTIVITY_LOG_FILE = 'activity-log.jsonl'
export const ACTIVITY_LOG_MAX_LINES = 2000
const KEEP_MS = 14 * 86_400_000
const FACT_RE = /^[\w.+@:-]{1,40}$/

export type ActivityLogKind = 'proactive' | 'job' | 'reminder' | 'cli_upgrade'
export interface ActivityLogEntry { at: number; kind: ActivityLogKind; status: string; ref?: string; facts?: Record<string, string> }

export function makeActivityLog(deps: { stateDir: string; now: () => number; log: (tag: string, line: string) => void }) {
  const file = join(deps.stateDir, ACTIVITY_LOG_FILE)
  let chain: Promise<void> = Promise.resolve()
  let sinceTrimCheck = 0

  const parse = (text: string): ActivityLogEntry[] => {
    const out: ActivityLogEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let o: Partial<ActivityLogEntry>
      try { o = JSON.parse(line) } catch { continue }
      if (typeof o?.at !== 'number' || typeof o.kind !== 'string' || typeof o.status !== 'string') continue
      out.push(o as ActivityLogEntry)
    }
    return out
  }
  async function trimIfNeeded() {
    const rows = parse(await readFile(file, 'utf8'))
    const cutoff = deps.now() - KEEP_MS
    let keep = rows.filter(r => r.at >= cutoff)
    if (keep.length > ACTIVITY_LOG_MAX_LINES) keep = keep.slice(-Math.floor(ACTIVITY_LOG_MAX_LINES / 2))
    if (keep.length === rows.length) return
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, keep.map(r => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''))
    await rename(tmp, file)
  }

  return {
    /** 记一行(不等它落盘)。 */
    append(e: { kind: ActivityLogKind; status: string; ref?: string; facts?: Record<string, string> }): void {
      const facts = e.facts ? Object.fromEntries(Object.entries(e.facts).filter(([k, v]) => FACT_RE.test(k) && typeof v === 'string' && FACT_RE.test(v))) : undefined
      // 状态只收短的码(sent / skipped:cap / failed …);不像码的一律记成 other,免得原因原文混进来
      const row: ActivityLogEntry = { at: deps.now(), kind: e.kind, status: /^[a-z_]+(?::[a-z_]+)?$/.test(e.status) ? e.status : 'other', ...(e.ref && FACT_RE.test(e.ref) ? { ref: e.ref } : {}), ...(facts && Object.keys(facts).length ? { facts } : {}) }
      chain = chain.then(async () => {
        try {
          await appendFile(file, JSON.stringify(row) + '\n')
          // 开机后第一次 + 每 100 行看一次要不要裁(不每行都读整份)
          if (sinceTrimCheck++ % 100 === 0) await trimIfNeeded()
        } catch (err) { deps.log('ACTIVITY', `append failed (${err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.name : 'error'})`) }
      })
    },
    /** 测试 / 停机用:等排着的写完。 */
    flush: () => chain,
    read(sinceMs: number): ActivityLogEntry[] {
      if (!existsSync(file)) return []
      try { return parse(readFileSync(file, 'utf8')).filter(r => r.at >= sinceMs) } catch { return [] }
    },
  }
}
export type ActivityLog = ReturnType<typeof makeActivityLog>
