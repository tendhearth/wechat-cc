/**
 * 微信「导入记忆 [来自哪]」(第二轮对标 #7,对标 Claude 的 import memory):
 * 1) 回一段话让主人贴到 ChatGPT / Gemini 那边;2) 主人把那边的回答贴回来 ⇒ 拆成编号的候选;
 * 3) 主人回「全部 / 1,3 / 不要」⇒ 只写他点过头的。写之前什么都不存。只认主人;30 分钟不回就作废。
 * 等粘贴时收到的不像清单(拆不出两条)⇒ 当普通聊天放过去,不吞主人的话。
 */
import { IMPORT_PROMPT, screenImportedMemory, splitImportedMemory, type ImportCandidate } from '../../core/memory-import'
import type { ReplyHandler } from '../commands/registry'
import type { ImportResult } from './nightly-runtime'

const TTL_MS = 30 * 60_000
const START = /^\s*导入记忆(?:\s+(.{1,20}))?\s*$/
/** 等粘贴时说这些 ⇒ 取消这次导入(重构第二批步 3a;以前会落进对话)。 */
const CANCEL = /^\s*(不要|取消|算了|不导了|不用了)\s*[。.!！]?\s*$/

/** 「全部」⇒ 全部下标;「1,3 / 1 3 / 1、3」⇒ 那几个(去重);「不要 / 取消 / 算了」⇒ [];认不出 / 越界 ⇒ null。 */
export function parsePick(text: string, n: number): number[] | null {
  const t = text.trim()
  if (/^(全部|都要|都记|全要)$/.test(t)) return [...Array(n).keys()]
  if (/^(不要|取消|算了|都不要)$/.test(t)) return []
  if (!/^\d{1,2}([\s,,、]+\d{1,2})*$/.test(t)) return null
  const picks = [...new Set(t.split(/[\s,,、]+/).map(Number))]
  if (picks.some(p => p < 1 || p > n)) return null
  return picks.sort((a, b) => a - b).map(p => p - 1)
}

type Stage = { kind: 'paste'; label: string; expiresAt: number } | { kind: 'pick'; label: string; items: ImportCandidate[]; expiresAt: number }

export function makeMemoryImportCommand(deps: {
  isOwner: (chatId: string) => boolean
  say: (chatId: string, text: string) => Promise<unknown>
  now: () => number
  importEntries: (items: ImportCandidate[], label: string) => Promise<ImportResult>
}): ReplyHandler {
  const stages = new Map<string, Stage>()
  const live = (chatId: string): Stage | null => {
    const s = stages.get(chatId)
    if (!s) return null
    if (s.expiresAt <= deps.now()) { stages.delete(chatId); return null }
    return s
  }
  const wants = (text: string, chatId: string): boolean => {
    if (!deps.isOwner(chatId)) return false
    if (START.test(text)) return true
    const s = live(chatId)
    if (!s) return false
    if (s.kind === 'paste') return CANCEL.test(text) || splitImportedMemory(text).length >= 2
    return parsePick(text, s.items.length) !== null
  }
  return {
    probe: wants,
    async handle(text, chatId) {
      if (!wants(text, chatId)) return false
      const start = START.exec(text)
      if (start) {
        const label = start[1]?.trim() || '别的助手'
        stages.set(chatId, { kind: 'paste', label, expiresAt: deps.now() + TTL_MS })
        await deps.say(chatId, `把下面这段发给${label === '别的助手' ? '那个助手' : ` ${label} `},再把它的回答整段贴回来给我(30 分钟内):\n\n${IMPORT_PROMPT}\n\n贴回来以后我会列出来,你点头的才记。`)
        return true
      }
      const s = live(chatId)!
      if (s.kind === 'paste' && CANCEL.test(text)) { stages.delete(chatId); await deps.say(chatId, '好,不导了。'); return true }
      if (s.kind === 'paste') {
        const { items, held } = screenImportedMemory(text)
        stages.set(chatId, { kind: 'pick', label: s.label, items, expiresAt: deps.now() + TTL_MS })
        // 像在给 CC 下指令 / 带链接的不收:原样列出来让主人看见(记忆每一轮都进提示词,评审 #440)
        const heldNote = held.length ? `\n\n这几条像是在给 CC 下指令或带链接,没收:\n${held.map(h => `· ${h}`).join('\n')}` : ''
        await deps.say(chatId, `从 ${s.label} 那边认出 ${items.length} 条:\n${items.map((it, i) => `${i + 1}. [${it.section}] ${it.text}`).join('\n')}${heldNote}\n\n回「全部」都记;回编号(比如「1,3」)只记那几条;回「不要」就一条都不记。`)
        return true
      }
      const picks = parsePick(text, s.items.length)!
      stages.delete(chatId)
      if (!picks.length) { await deps.say(chatId, '好,一条都没记。'); return true }
      try {
        const r = await deps.importEntries(picks.map(i => s.items[i]!), s.label)
        const skipped = [r.skipped.duplicate && `${r.skipped.duplicate} 条本来就记着`, r.skipped.corrected && `${r.skipped.corrected} 条你以前说过不对`, r.skipped.cap && `${r.skipped.cap} 条记不下了(记忆太长)`, r.skipped.invalid && `${r.skipped.invalid} 条格式不对`].filter(Boolean)
        await deps.say(chatId, `记下了 ${r.added} 条${skipped.length ? `(跳过:${skipped.join('、')})` : ''}。手机上「CC 眼中的你」能看到每条是从哪导入的,不对的点一下就能改。`)
      } catch { await deps.say(chatId, '这次没记上,过一会儿再试一次。') }
      return true
    },
  }
}
