/**
 * write-hints.ts —— 不进 MatterLog 游标的那几样写,给订阅的人一声「可能变了」(P2 第二步,设计稿 2026-11-02-p1-change-feed-design.md §P2)。
 *
 * 一件事的轮 / 步 / touch 走 MatterLog → matter-feed,那是「变了」的正式信号;这里只管它覆盖不到、手机主题又要看的几样:
 * 新的一条消息(messages)、matters 行本身(状态 / 标题 / updated_at)、觅食台条目(journal),
 * 还有两份文件:「主人看到哪了」的水位(journal-seen)和伙伴的念头(plan-log)。
 *
 * 不是事件总线,也不写任何行(设计稿否决了「非步的变化也写成一步」):只在写口落笔之后排一个微任务,
 * 同一拍里同样的提示合成一次,回调里只许 poke。外层事务回滚了也照样提示 —— 读的人重算一遍、发现没变就不推,
 * 比漏一次便宜。没人订就什么都不做(CLI 进程、回填导入几千行不付代价)。
 *
 * 按作用域分:库里的几样按 Db 对象(同一个库的所有 store 实例共用一份),文件按 stateDir 字符串。
 */
import type { Db } from './db'

export type WriteHint =
  | { kind: 'messages'; chatId: string }
  | { kind: 'topics'; chatId: string }
  | { kind: 'matter'; matterId: string }
  | { kind: 'journal' }
  | { kind: 'journal-seen' }
  | { kind: 'plan-log' }

type Listener = (hint: WriteHint) => void
interface Channel { listeners: Set<Listener>; pending: Map<string, WriteHint>; scheduled: boolean }

const byDb = new WeakMap<Db, Channel>()
const byDir = new Map<string, Channel>()

function channel(scope: Db | string, create: boolean): Channel | undefined {
  if (typeof scope === 'string') {
    let c = byDir.get(scope)
    if (!c && create) { c = { listeners: new Set(), pending: new Map(), scheduled: false }; byDir.set(scope, c) }
    return c
  }
  let c = byDb.get(scope)
  if (!c && create) { c = { listeners: new Set(), pending: new Map(), scheduled: false }; byDb.set(scope, c) }
  return c
}

const keyOf = (h: WriteHint): string =>
  h.kind === 'topics' ? `topics:${h.chatId}` : h.kind === 'messages' ? `messages:${h.chatId}` : h.kind === 'matter' ? `matter:${h.matterId}` : h.kind

/** 写口落笔之后调:排到微任务里发,同一拍里同样的提示只发一次。从不抛。 */
export function hintWrite(scope: Db | string, hint: WriteHint): void {
  const c = channel(scope, false)
  if (!c || c.listeners.size === 0) return
  c.pending.set(keyOf(hint), hint)
  if (c.scheduled) return
  c.scheduled = true
  queueMicrotask(() => {
    c.scheduled = false
    const batch = [...c.pending.values()]
    c.pending.clear()
    for (const h of batch) for (const cb of [...c.listeners]) { try { cb(h) } catch { /* 一个订的人炸了不影响别的 */ } }
  })
}

/** 订一个作用域的提示;返回退订。回调里只许 poke(别在写口的栈里回头读写库)。 */
export function onWriteHint(scope: Db | string, cb: Listener): () => void {
  const c = channel(scope, true)!
  c.listeners.add(cb)
  return () => {
    c.listeners.delete(cb)
    if (typeof scope === 'string' && c.listeners.size === 0 && !c.scheduled) byDir.delete(scope)
  }
}
