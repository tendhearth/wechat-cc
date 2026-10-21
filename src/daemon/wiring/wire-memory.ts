/**
 * 记忆这一块(重构第二批步 6c,从 pipeline-deps.ts 搬出来):LLM 记忆操作(概览合成 / 画像生成,微信管理命令与
 * 桌面内部 API 共用)、每晚整理 memory.md(定时器由 main.ts 挂)、欢迎时写一条观察。
 */
import { randomBytes } from 'node:crypto'
import type { Db } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import type { Bootstrap } from '../bootstrap'
import type { IlinkAdapter } from '../ilink-glue'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import { loadCompanionConfig } from '../companion/config'
import { shouldSpeak, careLevel } from '../companion/calibration'
import { makeMemoryLlmOps, resolveCheapEval } from '../memory-llm-ops'
import { makeMemoryNightlyRuntime, type MemoryNightlyRuntime } from '../memory/nightly-runtime'
import { makeNightlySources } from '../memory/nightly-sources'
import { makeMaybeWriteWelcomeObservation } from './side-effects'

export interface WireMemoryDeps {
  stateDir: string
  db: Db
  boot: Bootstrap
  chatPrefs: ChatPrefsStore
  careLedger: CareLedger
  ilink: Pick<IlinkAdapter, 'sendMessage'>
  log: (tag: string, line: string) => void
}

export function wireMemory(d: WireMemoryDeps) {
  const { stateDir, db, boot, chatPrefs, careLedger, ilink, log } = d
  // Shared LLM-backed memory ops (overview synthesis + profile generation),
  // wired with the daemon's OWN provider registry/coordinator so both the
  // WeChat admin-command path (below) and the internal-api routes the
  // desktop calls resolve cheapEval identically. Built once and reused.
  const memoryLlmOps = makeMemoryLlmOps({
    stateDir,
    db,
    getMode: (cid) => boot.coordinator.getMode(cid),
    registry: boot.registry,
  })
  // 每晚整理长期记忆 memory.md(spec 2026-09-25-memory-nightly-design)。定时器由 main.ts 挂。
  const nightlyOwner = (): string | null => loadCompanionConfig(stateDir).default_chat_id ?? null
  const nightlyRuntime = makeMemoryNightlyRuntime({
    stateDir,
    ownerChatId: nightlyOwner,
    config: () => {
      const c = loadCompanionConfig(stateDir)
      return { enabled: c.memory_nightly_enabled, at: c.memory_nightly_at, timezone: c.timezone }
    },
    sources: makeNightlySources({ db, stateDir, ownerChatId: nightlyOwner }),
    cheapEval: () => {
      const o = nightlyOwner()
      return o ? resolveCheapEval({ getMode: (c) => boot.coordinator.getMode(c), registry: boot.registry }, o) : boot.registry.getCheapEval()
    },
    ownerRecentlyActive: async () => {
      const o = nightlyOwner()
      if (!o) return false
      const ts = await makeMessagesStore(db).latestInboundTs(o)
      return !!ts && Date.now() - Date.parse(ts) < 3 * 60_000
    },
    now: () => Date.now(),
    newId: () => randomBytes(3).toString('hex'),
    log: (t, l) => log(t, l),
    careGate: (chatId, nowIso) => shouldSpeak({
      kind: 'memory',
      level: careLevel(chatId, chatPrefs.get(chatId), loadCompanionConfig(stateDir).default_chat_id ?? undefined),
      nowIso,
      ledger: careLedger.get(chatId),
    }),
    claim: (chatId, nowIso) => careLedger.claimMemory(chatId, nowIso),
    wechatSuspended: () => boot.health.health.shouldSuspend('wechat'),
    send: (chatId, text) => ilink.sendMessage(chatId, text),
  })
  // 手动立即运行(内部 API / 以后的微信「整理记忆」)可能跑到 5 分钟 —— 持 busy token,
  // 免得空闲自动重启把它杀掉。定时 tick 的 busy 由 registerMemoryNightly 自己持。
  const memoryNightly: MemoryNightlyRuntime = {
    ...nightlyRuntime,
    runNow: async () => {
      const release = boot.holdBusy('memory-nightly-manual')
      try { return await nightlyRuntime.runNow() } finally { release() }
    },
  }
  const maybeWriteWelcomeObservation = makeMaybeWriteWelcomeObservation({
    stateDir,
    db,
    agentConfig: boot.agentConfig,
    getMode: (cid) => boot.coordinator.getMode(cid),
  })
  return { memoryLlmOps, memoryNightly, maybeWriteWelcomeObservation }
}
