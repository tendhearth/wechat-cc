/**
 * terminal-steps.ts —— 终端会话的记录增量读进这件事的步(M4b,设计稿 docs/superpowers/specs/2026-11-04-m4-terminal-matter-design.md)。
 *
 * 每件事记读到第几个字节;钩子事件来了 / 有人来看的时候,只读新增的那一段(到最后一个换行为止 —— 最后一行已经是完整的一条也算;读到一半的那一行留给下一次),
 * 用 cli-activity.ts 的 feedActivity 解析 —— 合并「一串读 x」、结果挂回调用那一步的口径和以前逐次重解析完全一样,
 * 只是状态(最后一条、还在等结果的调用)存在库里,跨进程接得上。
 *
 * 第一次读(或者文件被截短 / 一下子多出 4MB 以上):从尾巴 256KB 开始,丢掉被截断的第一行 —— 和「看着它跑」以前读的那一截一样,
 * 不把几十 MB 的老记录整份导进来(钩子的回包有时限)。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { STEP_KEY_PREFIX, type TerminalStepStore, type TerminalStepWrite } from '../../ports/terminal-steps'
import { feedActivity, type CliActivityItem } from './cli-activity'

export const STEPS_FIRST_READ = 256 * 1024
export const STEPS_JUMP = 4 * 1024 * 1024

export interface TerminalSteps {
  /** 读新增的那一段进这件事。这个会话还没有那件事(钩子没来过)⇒ false。读不了文件 ⇒ 抛。 */
  ingest(sessionId: string, path: string, source: string): boolean
  /** 先 ingest,再给最近 max 步(旧 → 新)。还没有那件事 ⇒ null(调用方退回直接解析)。 */
  view(s: { session_id: string; transcript_path?: string | null; source: string }, max: number): CliActivityItem[] | null
}

const readBytes = (path: string, from: number, to: number): Buffer => {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    let got = 0
    while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, from + got); if (n <= 0) break; got += n }
    return buf.subarray(0, got)
  } finally { closeSync(fd) }
}
const wholeLine = (b: Buffer): boolean => {
  const t = b.toString('utf8').trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return false
  try { return typeof JSON.parse(t) === 'object' } catch { return false }
}
const KIND: Record<CliActivityItem['kind'], TerminalStepWrite['kind']> = { you: 'user_message', said: 'agent_message', step: 'tool_call' }

export function makeTerminalSteps(deps: { store: TerminalStepStore; size?: (path: string) => number; read?: (path: string, from: number, to: number) => Buffer }): TerminalSteps {
  const { store } = deps
  const sizeOf = deps.size ?? ((p: string) => statSync(p).size)
  const read = deps.read ?? readBytes
  const ingest = (sessionId: string, path: string, source: string): boolean => {
    const matterId = store.matterOf(sessionId)
    if (!matterId) return false
    const size = sizeOf(path)
    const st = store.readState(matterId)
    const fresh = !st || st.path !== path || size < st.offset || size - st.offset > STEPS_JUMP
    let from = fresh ? Math.max(0, size - STEPS_FIRST_READ) : st!.offset
    const gen = !st ? 0 : fresh ? st.gen + 1 : st.gen
    if (!fresh && from === size) return true
    let buf = read(path, from, size)
    if (fresh && from > 0) {
      const nl = buf.indexOf(0x0a)
      if (nl < 0) { store.apply(matterId, [], { path, offset: from, gen, pending: {} }); return true }
      buf = buf.subarray(nl + 1); from += nl + 1
    }
    let lastNl = buf.lastIndexOf(0x0a)
    // 最后一行没换行、但已经是完整的一条(有的写法最后一行不带换行)⇒ 也算读完了;读到一半的那一行解析不了,留给下一次
    if (lastNl < buf.length - 1 && wholeLine(buf.subarray(lastNl + 1))) lastNl = buf.length
    const pending = fresh ? {} : { ...st!.pending }
    if (lastNl < 0) { if (fresh) store.apply(matterId, [], { path, offset: from, gen, pending }); return true }
    const dirty = new Map<string, CliActivityItem>()
    const l0 = store.last(matterId)
    let last: { key: string; item: CliActivityItem } | null = l0 ? { key: l0.key, item: l0.payload as unknown as CliActivityItem } : null
    feedActivity<string>(buf.subarray(0, lastNl).toString('utf8'), source as never, {
      last: () => (last ? { ref: last.key, item: last.item } : null),
      push(item, at) {
        const key = `${STEP_KEY_PREFIX}${gen}:${at.line}:${at.index}`
        dirty.set(key, item); last = { key, item }
        return key
      },
      update(ref, item) { dirty.set(ref, item); if (last?.key === ref) last.item = item },
      claim(callId, ref, keepOutput) { pending[callId] = [ref, keepOutput] },
      take(callId) {
        const p = pending[callId]
        if (!p) return null
        delete pending[callId]
        const item = dirty.get(p[0]) ?? (last?.key === p[0] ? last.item : (store.item(matterId, p[0]) as unknown as CliActivityItem | null))
        return item ? { ref: p[0], item, keepOutput: p[1] } : null
      },
    }, from)
    const writes: TerminalStepWrite[] = [...dirty].map(([key, item]) => ({ key, kind: KIND[item.kind], status: item.error ? 'failed' : 'completed', payload: item as unknown as Record<string, unknown> }))
    store.apply(matterId, writes, { path, offset: Math.min(size, from + lastNl + 1), gen, pending })
    return true
  }
  return {
    ingest,
    view(s, max) {
      if (!s.transcript_path) return null
      if (!ingest(s.session_id, s.transcript_path, s.source)) return null
      const id = store.matterOf(s.session_id)
      return id ? store.recent(id, max) as unknown as CliActivityItem[] : null
    },
  }
}
