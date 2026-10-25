/**
 * 早报里「要你拍板的(CC 自己找到的)」那一段的回话:主人回「2」/「2 要」⇒ 要,「2 不要」⇒ 不要
 * (设计稿 2026-10-23-cc-runs-development §4.8,主人 10-24)。答案记进 owner-asks.json 那一条:谁、什么时候、哪一版。
 *
 * 只在**最近一份早报真问过这个编号、那一条还在等回、在 12 小时窗口里**时认领 —— 别的时候「2」还是普通聊天(比如 CC 刚问「选 1 还是 2」),
 * 交给后面的命令和模型。只认主人。
 * 这一版只记答案,不替主人去做:批了的那条怎么进开发流程是第 7 步(要在核心链之后),所以回话里不承诺「马上去做」。
 */
import { lookupAsk, parseAskReply } from '../../core/owner-asks'
import type { OwnerAsksStore } from '../../core/owner-asks-store'
import type { ReplyHandler } from '../../daemon/commands/registry'

export function makeAsksReply(deps: {
  store: OwnerAsksStore
  isOwner: (chatId: string) => boolean
  say: (chatId: string, text: string) => Promise<unknown>
  now: () => number
  log: (tag: string, line: string) => void
}): ReplyHandler {
  const claimed = (text: string, chatId: string) => {
    const p = parseAskReply(text)
    if (!p || !deps.isOwner(chatId)) return null
    try { return lookupAsk(deps.store.read(), p.no, deps.now()) ? p : null } catch { return null }
  }
  return {
    probe: (text, chatId) => claimed(text, chatId) !== null,
    async handle(text, chatId) {
      const p = claimed(text, chatId)
      if (!p) return false
      const nowIso = new Date(deps.now()).toISOString()
      // 文件被另一个进程(CLI 正在排候选)同时改了 ⇒ updateJsonFile 抛 ConcurrentJsonUpdateError;重试一次,
      // 还不行就照实说没记上 —— 主人的「2」不能既没记下、又没进聊天(整合者评审 #659)。
      let r: ReturnType<OwnerAsksStore['answer']> | null = null
      for (let attempt = 0; attempt < 2 && !r; attempt++) {
        try { r = deps.store.answer({ no: p.no, verdict: p.verdict, by: chatId, nowIso }) }
        catch (e) { deps.log('OWNER_ASK', `answer ${p.no} failed (attempt ${attempt + 1}): ${e instanceof Error ? e.message : String(e)}`) }
      }
      if (!r) { await deps.say(chatId, `${p.no} 没记上(记录文件正忙),再回一次「${text.trim()}」就行。`); return true }
      // 探针之后、记之前这条被答掉了 / 窗口刚过 ⇒ 不归这里,交给后面的命令和聊天。
      if (r.result === 'none') return false
      deps.log('OWNER_ASK', `${r.item.id} key=${r.item.key} → ${p.verdict} hash=${r.item.hash.slice(0, 12)}`)
      const q = r.item.question
      await deps.say(chatId, p.verdict === 'approved'
        ? `记下了,${p.no} 要:${q}`
        : `记下了,${p.no} 不要:${q}\n以后不再提。`)
      return true
    },
  }
}

/** 两个处理器并成一个(命令表里还是 jobs 那一格,不动 main.ts 的命令顺序):先认定时,再认拍板的回话。 */
export function combineReplyHandlers(...hs: ReplyHandler[]): ReplyHandler {
  return {
    probe: (text, chatId) => hs.some(h => { try { return h.probe(text, chatId) } catch { return false } }),
    async handle(text, chatId) {
      for (const h of hs) {
        let mine = false
        try { mine = h.probe(text, chatId) } catch { mine = false }
        if (mine && await h.handle(text, chatId)) return true
      }
      return false
    },
  }
}
