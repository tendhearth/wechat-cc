/** CC 的信(2026-10-16):把 letters/runtime 接到真库、真微信、真模型,并挂 15 分钟一次的 tick。 */
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import type { Db } from '../../lib/db'
import type { Lifecycle } from '../../lib/lifecycle'
import { makeMessagesStore } from '../../lib/messages-store'
import { loadCompanionConfig } from '../../daemon/companion/config'
import { startCompanionScheduler } from '../../daemon/companion/scheduler'
import { MEMORY_FILENAME, parseMemoryDoc, renderForPrompt } from '../memory'
import { makeMemoryFS } from '../../adapters/store/memory-fs'
import { makeLetterRuntime, type LetterApp, type LetterRuntime } from './runtime'
import type { AppChannel } from '../../daemon/companion/proactive-channel'
import { rasterizeLetterPage } from './render'

type Eval = (prompt: string) => Promise<string>

export interface WireLettersDeps {
  stateDir: string
  db: Db
  /** 主人当前对话的 provider(solo 模式)。信一个月才一封、要有性格:先用 Claude 的主模型,
   *  再用主人这家的 strongEval,最后才退到 cheapEval(真机 10-16:网关小模型写成了一串数字和四件不相干的事)。 */
  providerFor(chatId: string): string | undefined
  strongEval(providerId: string): Eval | null
  cheapEval(chatId: string): Eval | null
  wechatSuspended(): boolean
  /** CC 开口那道门(main.ts 的 wired.speech)。 */
  speech: import('../../daemon/speech/policy').SpeechPolicy
  sendText(chatId: string, text: string): Promise<{ error?: string }>
  /** 逐页发;这里发的页不该再被媒体镜像逐页记(main.ts 传 mirror:false),整封由 `mirror` 记成一行。 */
  sendFile(chatId: string, path: string): Promise<void>
  /** 微信寄出之后整封记进 App 对话页(几页一行)。 */
  mirror?(chatId: string, pages: string[]): void
  /** CC 主动找你的 App 那条路(proactive-channel 的 AppChannel);没开中继 v2 / 没配对 ⇒ null。 */
  app?(): AppChannel | null
  holdBusy(label: string): () => void
  log(tag: string, line: string): void
}

/** 推送正文(daemon 的推送正文本来就是中文,同伙伴推送)。 */
export const LETTER_PUSH_BODY = 'CC 给你写了一封信'

/**
 * 一封信寄到 App:几页图记成主人对话里 CC 的一行(附件 = 存档里那几张 PNG 的引用,手机按块读),
 * 排不成图的退回文字(同微信那头的「(一封信)」);记上了再推一条。
 */
export function letterToApp(app: AppChannel): LetterApp {
  return {
    deliverable: (chatId) => app.deliverable(chatId),
    async deliver(chatId, letter) {
      const ok = letter.pages.length
        ? await app.record(chatId, '', letter.pages.map(p => ({ kind: 'file' as const, name: basename(p), path: p })))
        : await app.record(chatId, `（一封信）\n\n${letter.text}`)
      if (ok) app.push(LETTER_PUSH_BODY)
      return ok
    },
  }
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
      return d.strongEval('claude') ?? (p ? d.strongEval(p) : null) ?? d.cheapEval(c)
    },
    wechatSuspended: d.wechatSuspended,
    // 能不能写 / 寄:CC 开口那道门(第三批 3a)—— 免打扰、别烦我、两条路都送不到都由它判,跟别的主动开口同一份
    speech: d.speech,
    sendText: d.sendText,
    sendFile: d.sendFile,
    ...(d.mirror ? { mirror: d.mirror } : {}),
    ...(d.app ? { app: () => { const a = d.app!(); return a ? letterToApp(a) : null } } : {}),
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
