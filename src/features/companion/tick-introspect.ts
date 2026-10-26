/**
 * 每天一次的自省那一拍(从 tick-bodies.ts 原样搬出):本地导入 → 观察 → 线索 → 总览 → 备份,然后是登记进来的几步
 * (ports/companion-contributions.ts 的 IntrospectStep,登记表在 daemon/wiring/tick-bodies.ts)。
 * 反思要的记忆快照由记忆功能做(`memorySnapshot`,组装的地方交进来):陪伴不 import 别的功能。
 */
import { join } from 'node:path'
import { loadCompanionConfig, saveCompanionConfig } from '../../lib/companion-config'
import { makeEventsStore } from '../../daemon/events/store'
import { makeObservationsStore } from '../../daemon/observations/store'
import { runIntrospectTick } from './introspect'
import { resolveIntrospectChatId, makeIntrospectAgent } from './introspect-runtime'
import { makeMessagesStore } from '../../lib/messages-store'
import { recentInboundTexts } from './recent-inbound'
import { makeThreadsStore } from '../../lib/threads-store'
import { runThreadsExtraction } from '../../daemon/threads/extractor'
import { runLocalImportIfEnabled } from '../../daemon/local-import'
import { synthesizeOverview, type SynthesisMemory } from '../../lib/memory-synthesis'
import { makeLifeStoresReader } from '../../daemon/life-stores'
import { isNetworkUnprotectedError } from '../../lib/network-gate'
import type { TickDeps } from './tick-deps'
import type { IntrospectStep, MemorySnapshot } from '../../ports/companion-contributions'
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

export function makeIntrospectTick(deps: TickDeps, steps: readonly IntrospectStep[], memorySnapshot: MemorySnapshot, synthesisMemory: (chatId: string) => SynthesisMemory): (opts?: { nowIso?: string }) => Promise<void> {
  async function introspectTick(opts?: { nowIso?: string }): Promise<void> {
    // opts.nowIso is otherwise ignored for MVP — observations/memory internal
    // timestamps stay wall-clock. Keeping the symmetric signature avoids
    // churn when introspect virtual time is added later. The one consumer
    // today is the memory gardener's `today` below.
    const nowIso = opts?.nowIso ?? new Date().toISOString()
    const today = nowIso.slice(0, 10)
    // Opt-in local-history import (zero-LLM). Runs FIRST, before the
    // chatId/sdkEval gates below, since it needs neither — the 对话 archive
    // should populate even on a misconfigured / cheap-eval-less install.
    // No-op unless companion.import_local_history is on.
    await runLocalImportIfEnabled(deps.stateDir, deps.db, deps.log)

    const chatId = resolveIntrospectChatId(deps.stateDir)
    if (!chatId) { deps.log('INTROSPECT', 'skip tick — no default_chat_id'); return }
    // PR F — resolve cheap eval via the registry. Picks the cheapest
    // available provider (claude haiku, then codex-mini, then anything
    // else registered). null if no registered provider implements
    // cheapEval → skip the tick with a log line instead of hard-failing.
    //
    // Per-tick resolution (not boot-time) is forward-looking for a
    // future where ProviderRegistry supports hot registration; TODAY a
    // user installing a new provider still needs to restart the daemon
    // (registry is built once at bootstrap) AND the codex provider's
    // cheapModel was resolved at provider construction so `codex login`
    // unlocking a cheaper tier requires a restart too.
    const sdkEval = deps.boot.registry.getCheapEval()
    if (!sdkEval) {
      deps.log('INTROSPECT', 'skip tick — no registered provider implements cheapEval')
      return
    }
    const memoryRoot = join(deps.stateDir, 'memory')
    const events = makeEventsStore(deps.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'events.jsonl') })
    const observations = makeObservationsStore(deps.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl') })
    // Hoisted above the agent so introspect and threads extraction share one
    // store — introspect's recent-inbound feed reads the same canonical
    // messages table the extractor consumes.
    const messagesStore = makeMessagesStore(deps.db)
    const agent = makeIntrospectAgent({
      chatId, events, observations,
      memorySnapshot: () => memorySnapshot(deps.stateDir, chatId),
      recentInboundMessages: () => recentInboundTexts(messagesStore, chatId),
      sdkEval,
    })
    // Isolated so a rare introspect-side throw (e.g. events.append db error)
    // cannot starve the threads extraction below — the two evals are
    // independent by design (spec D3).
    try {
      await runIntrospectTick({ events, observations, agent, chatId, log: deps.log })
      await saveCompanionConfig(deps.stateDir, { ...loadCompanionConfig(deps.stateDir), last_introspect_at: new Date().toISOString() })
    } catch (err) {
      // 评审 #193 P2-3:反思那一次模型调用被网络守护拒了 —— 没反思过,last_introspect_at 不能前移
      // (否则开机补跑会以为今天跑过了)。
      if (isNetworkUnprotectedError(err)) deps.log('INTROSPECT', 'skipped — network unprotected; last_introspect_at unchanged, next tick retries')
      else deps.log('INTROSPECT', `tick failed: ${err instanceof Error ? err.message : err}`)
    }

    // Threads extraction — independent eval, same cheap model, same tick.
    // Run for every chat that has messages so other chats' conversations
    // also accumulate threads, not just the companion default_chat_id.
    // Parse failure per-chat is swallowed: watermark stays, retried next tick.
    // One-chat failure does not abort extraction for the remaining chats.
    const threadsStore = makeThreadsStore(deps.db)
    let allChatIds: string[]
    try {
      allChatIds = await messagesStore.listChatIds()
    } catch (err) {
      deps.log('THREADS', `listChatIds failed: ${err instanceof Error ? err.message : err}`)
      allChatIds = []
    }
    for (const extractChatId of allChatIds) {
      try {
        const chatEvents = makeEventsStore(deps.db, extractChatId)
        await runThreadsExtraction({
          chatId: extractChatId,
          messages: messagesStore,
          threads: threadsStore,
          sdkEval,
          recordEvent: async (reasoning) => {
            await chatEvents.append({ kind: 'threads_extracted', trigger: 'introspect', reasoning })
          },
          log: deps.log,
        })
      } catch (err) {
        deps.log('THREADS', `extraction failed for chat ${extractChatId}: ${err instanceof Error ? err.message : err}`)
      }
    }

    // Opt-in 24h overview refresh — the one LLM cost of the auto-memory feature
    // (1 cheap-eval call/day). Reuses the resolved chatId (admin) + sdkEval.
    // No-op unless companion.import_local_history is on.
    if (loadCompanionConfig(deps.stateDir).import_local_history) {
      try {
        await synthesizeOverview({ stateDir: deps.stateDir, adminChatId: chatId, memory: synthesisMemory(chatId), sdkEval, lifeStores: makeLifeStoresReader(deps.db, deps.stateDir), includeFileSurvey: true })
        deps.log('SYNTHESIZE', `overview refreshed for ${chatId} (24h auto)`)
      } catch (err) {
        deps.log('SYNTHESIZE', `auto refresh failed: ${err instanceof Error ? err.message : err}`)
      }
    }

    // Daily backup (2026-08-24) — the irreplaceable slice (main db, facts,
    // memory .md, configs) is ~2MB; snapshotting it once per introspect tick
    // is the cheapest insurance in the codebase. Isolated try/catch like
    // every other step; keep a two-week window.
    try {
      const { createBackup, pruneBackups } = await import('../../lib/backup')
      const b = await createBackup({ stateDir: deps.stateDir })
      const pruned = pruneBackups(deps.stateDir, 14)
      deps.log('BACKUP', `daily snapshot ${b.path.split('/').pop()} (${Math.round(b.bytes / 1024)}KB)${pruned > 0 ? `, pruned ${pruned}` : ''}`)
    } catch (err) {
      deps.log('BACKUP', `daily snapshot failed: ${err instanceof Error ? err.message : err}`)
    }

    // 之后是登记进来的几步(贴纸 / 小像 / 记忆园丁 / 画室,登记表在 daemon/wiring/tick-bodies.ts),按登记顺序一步一步跑;
    // 每步自己门控,一步抛了只记一行,不拖累后面的步 —— 同搬家前每段各包一层 try。
    for (const step of steps) {
      try {
        await step.run({ nowIso, today, sdkEval, memoryRoot })
      } catch (err) {
        deps.log(step.logTag, `${step.failLabel} failed: ${errMsg(err)}`)
      }
    }
  }

  return introspectTick
}
