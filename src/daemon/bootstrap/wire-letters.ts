/** CC 的信(2026-10-16):把 letters/runtime 接到真库、真微信、真模型,并挂 15 分钟一次的 tick。 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Db } from '../../lib/db'
import type { Lifecycle } from '../../lib/lifecycle'
import { makeMessagesStore } from '../../lib/messages-store'
import { loadCompanionConfig } from '../companion/config'
import { startCompanionScheduler } from '../companion/scheduler'
import { MEMORY_FILENAME, parseMemoryDoc, renderForPrompt } from '../memory/curated-doc'
import { makeMemoryFS } from '../memory/fs-api'
import { makeLetterRuntime, type LetterRuntime } from '../letters/runtime'
import { rasterizeLetterPage } from '../letters/render'

type Eval = (prompt: string) => Promise<string>

export interface WireLettersDeps {
  stateDir: string
  db: Db
  /** 主人当前对话的 provider(solo 模式);信要有性格 —— strongEval 优先,没有再退到 cheapEval */
  providerFor(chatId: string): string | undefined
  strongEval(providerId: string): Eval | null
  cheapEval(chatId: string): Eval | null
  wechatSuspended(): boolean
  sendText(chatId: string, text: string): Promise<{ error?: string }>
  sendFile(chatId: string, path: string): Promise<void>
  holdBusy(label: string): () => void
  log(tag: string, line: string): void
}

export function wireLetters(d: WireLettersDeps): { runtime: LetterRuntime; start(): Lifecycle } {
  const owner = () => loadCompanionConfig(d.stateDir).default_chat_id ?? null
  const messages = makeMessagesStore(d.db)
  const base = makeLetterRuntime({
    stateDir: d.stateDir,
    enabled: () => loadCompanionConfig(d.stateDir).letters_enabled,
    timezone: () => loadCompanionConfig(d.stateDir).timezone,
    ownerChatId: owner,
    memory: (c) => {
      const raw = makeMemoryFS({ rootDir: join(d.stateDir, 'memory', c) }).read(MEMORY_FILENAME)
      return raw ? renderForPrompt(parseMemoryDoc(raw)) : ''
    },
    chatSince: async (c, sinceIso) => {
      const rows = (await messages.listRange(c, { limit: 400 })).filter(m => m.ts > sinceIso)
      return rows.filter(m => m.kind === 'text' && m.text.trim())
        .map(m => `${m.direction === 'in' ? '主人' : 'CC'}:${m.text.slice(0, 300)}`)
    },
    lastInboundAt: async (c) => {
      const ts = await messages.latestInboundTs(c)
      return ts ? Date.parse(ts) : null
    },
    evalText: () => {
      const c = owner()
      if (!c) return null
      const p = d.providerFor(c)
      return (p ? d.strongEval(p) : null) ?? d.cheapEval(c)
    },
    wechatSuspended: d.wechatSuspended,
    sendText: d.sendText,
    sendFile: d.sendFile,
    rasterize: rasterizeLetterPage,
    now: () => Date.now(),
    random: Math.random,
    newId: () => randomBytes(3).toString('hex'),
    log: d.log,
  })
  // 当面要的那封可能写上几分钟 —— 持 busy token,空闲自动重启别掐断它。定时 tick 的由调度器自己持。
  const runtime: LetterRuntime = {
    ...base,
    writeNow: async (request) => {
      const release = d.holdBusy('letters-manual')
      try { return await base.writeNow(request) } finally { release() }
    },
  }
  return {
    runtime,
    start: () => {
      const scheduler = startCompanionScheduler({
        name: 'letters', intervalMs: 15 * 60_000, jitterRatio: 0,
        shouldRun: () => true, onTick: () => base.tick(), log: d.log, holdBusy: d.holdBusy,
      })
      let stopped = false
      return { name: 'letters', stop: async () => { if (!stopped) { stopped = true; await scheduler.stop() } } }
    },
  }
}
