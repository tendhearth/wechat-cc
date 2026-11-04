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
import { STEP_KEY_PREFIX, type TerminalStepPayload, type TerminalStepStore, type TerminalStepWrite } from '../../ports/terminal-steps'
import type { TerminalEventIn, TerminalTurnLog } from '../../ports/terminal-turns'
import { feedActivity } from './cli-activity'

export const STEPS_FIRST_READ = 256 * 1024
export const STEPS_JUMP = 4 * 1024 * 1024

export interface TerminalSteps {
  /** 读新增的那一段进这件事。这个会话还没有那件事(钩子没来过)⇒ false。读不了文件 ⇒ 抛。 */
  ingest(sessionId: string, path: string, source: string): boolean
  /**
   * 有人来看(手机「看着它跑」、列表那一步、微信「看 码」):先 ingest,再给最近 max 步(旧 → 新)。
   * 还没有那件事(钩子没来过的老会话)⇒ 当场建、导入一次(同钩子那条路:turns.ensure + ingest;第一次读照旧从尾巴 256KB 起),
   * 之后只读步(M6d)。只在看的这条路上建 —— 钩子的回包有时限,钩子里不导入整份。
   * 调用方先挡掉那边(别的机器 / A2A)的会话:记录不在这台机器上。没报记录路径 ⇒ 空。读不了文件 ⇒ 抛。
   */
  view(s: TerminalSessionRef, max: number): TerminalStepPayload[]
}

/** 看的时候要的那几样(登记处的 CliSessionInfo 都有):建那件事要 source / cwd / 机器。 */
export type TerminalSessionRef = { session_id: string; transcript_path?: string | null; source: string } & Partial<Pick<TerminalEventIn, 'cwd' | 'machine' | 'origin_agent'>>

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
const KIND: Record<TerminalStepPayload['kind'], TerminalStepWrite['kind']> = { you: 'user_message', said: 'agent_message', step: 'tool_call' }

export function makeTerminalSteps(deps: {
  store: TerminalStepStore
  /** 首见建那件事(= 钩子那条路的 turns.ensure)。 */
  turns: Pick<TerminalTurnLog, 'ensure'>
  size?: (path: string) => number
  read?: (path: string, from: number, to: number) => Buffer
}): TerminalSteps {
  const { store, turns } = deps
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
    const dirty = new Map<string, TerminalStepPayload>()
    const l0 = store.last(matterId)
    let last: { key: string; item: TerminalStepPayload } | null = l0 ? { key: l0.key, item: l0.payload as unknown as TerminalStepPayload } : null
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
        const item = dirty.get(p[0]) ?? (last?.key === p[0] ? last.item : (store.item(matterId, p[0]) as unknown as TerminalStepPayload | null))
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
      if (!s.transcript_path) return []
      let id = store.matterOf(s.session_id)
      // 记录读不了(文件没了)⇒ 先抛,别为它建一件空的事
      if (!id) sizeOf(s.transcript_path)
      id ??= turns.ensure({
        source: s.source, session_id: s.session_id, cwd: s.cwd ?? '',
        ...(s.machine ? { machine: s.machine } : {}), ...(s.origin_agent ? { origin_agent: s.origin_agent } : {}),
      })
      ingest(s.session_id, s.transcript_path, s.source)
      return store.recent(id, max) as unknown as TerminalStepPayload[]
    },
  }
}

/**
 * 钩子事件进这件事的轮 / 步,顺带把记录新增的那一段读进步(M4b)。
 * 先确保有这件事(第一个钩子就是 stop 的老会话也一样),再读:答完 / 结束时最后几步挂在还开着的那一轮上。
 * 读上了 ⇒ 发问原文 / 最后一句从记录来,钩子不再各写一步;读不上 ⇒ 钩子照旧写(Codex 评审:两种都别丢、别重)。
 * 发问原文多半在 UserPromptSubmit 之后才进记录 ⇒ 下一次读(答完时)进这一轮。权限请求不读(同步钩子,要快)。
 * 那边(别的机器 / 经 A2A 转来)的会话:记录不在这台机器上,不读。
 */
/** 答完之后多久补读一次记录。 */
export const STOP_SETTLE_MS = 3_000

export function withTranscriptSteps(deps: {
  turns: TerminalTurnLog
  steps: Pick<TerminalSteps, 'ingest'>
  localMachine: string
  lookup: (sessionId: string) => { session_id: string; transcript_path?: string | null } | null
  log: (line: string) => void
  /** 答完之后补读一次的定时(测试注入);默认 setTimeout + unref。 */
  later?: (fn: () => void, ms: number) => void
}): TerminalTurnLog {
  const { turns, steps, log } = deps
  const later = deps.later ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.() })
  const err = (e: unknown) => (e instanceof Error ? e.message : String(e))
  const transcriptOf = (ev: TerminalEventIn): string | null => {
    if (ev.origin_agent || (ev.machine && ev.machine !== deps.localMachine)) return null
    if (ev.transcript_path) return ev.transcript_path
    const s = deps.lookup(ev.session_id)
    return s && s.session_id === ev.session_id ? s.transcript_path ?? null : null
  }
  return {
    ...turns,
    event(ev, at) {
      const path = transcriptOf(ev)
      if (!path) { turns.event(ev, at); return }
      let ok = false
      try { turns.ensure(ev); ok = steps.ingest(ev.session_id, path, ev.source) } catch (e) { log(`steps ${ev.kind} ${ev.session_id.slice(0, 6)} failed: ${err(e)}`) }
      turns.event(ok ? { ...ev, transcribed: true } : ev, at)
      // 答完那一刻最后一句往往和钩子同时才写进记录(真机 11-04:同一秒),这一次读不到 ⇒ 过一会儿再读一次,
      // 不然「看着它跑」和「最近一句」(M4d 从步推)要等下一个钩子才有最后一句。读是增量 + 按位置定键的,多读不会重。
      if (ok && ev.kind === 'stop') later(() => {
        try { steps.ingest(ev.session_id, path, ev.source) } catch (e) { log(`steps settle ${ev.session_id.slice(0, 6)} failed: ${err(e)}`) }
      }, STOP_SETTLE_MS)
    },
  }
}
