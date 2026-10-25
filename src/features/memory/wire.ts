/**
 * 记忆这一块(重构第二批步 6c,从 pipeline-deps.ts 搬出来;架构终态 A5 随记忆进 src/features/memory):LLM 记忆操作
 * (概览合成 / 画像生成,微信管理命令用)、每晚整理 memory.md 的运行时(定时器是 `memory-nightly` 模块)。
 * 它要 CC 开口那道门,门在 wired 里才造,所以由 wired(pipeline-deps)经 index.ts 调;
 * 欢迎时写一条观察不是记忆的事,留在 pipeline-deps 自己造。
 */
import { randomBytes } from 'node:crypto'
import type { Db } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import type { Bootstrap } from '../../daemon/bootstrap'
import type { SpeechPolicy } from '../../daemon/speech/policy'
import type { ChatPrefsStore } from '../../daemon/chat-prefs'
import type { CareLedger } from '../../daemon/companion/care-ledger'
import { loadCompanionConfig } from '../../daemon/companion/config'
import { shouldSpeak, careLevel } from '../../daemon/companion/calibration'
import { makeMemoryLlmOps, resolveCheapEval } from './llm-ops'
import { makeMemoryNightlyRuntime, type MemoryNightlyRuntime } from './nightly-runtime'
import { makeNightlySources } from './nightly-sources'

export interface WireMemoryDeps {
  stateDir: string
  db: Db
  boot: Bootstrap
  chatPrefs: ChatPrefsStore
  careLedger: CareLedger
  /** CC 主动开口唯一的门:整理完的那一句通知经它发(第三批 3a)。 */
  speech: SpeechPolicy
  log: (tag: string, line: string) => void
}

export function wireMemory(d: WireMemoryDeps) {
  const { stateDir, db, boot, chatPrefs, careLedger, speech, log } = d
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
    speech,
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
  return { memoryLlmOps, memoryNightly }
}
