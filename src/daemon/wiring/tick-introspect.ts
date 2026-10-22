/**
 * 每天一次的自省那一拍(观察 / 记忆整理 / 贴纸 / 小像 / 画室,从 tick-bodies.ts 原样搬出)+ 新贴纸那一句。
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { loadCompanionConfig, saveCompanionConfig } from '../companion/config'
import { buildMemorySnapshot } from '../memory/snapshot'
import { makeEventsStore } from '../events/store'
import { makeObservationsStore } from '../observations/store'
import { runIntrospectTick } from '../companion/introspect'
import { resolveIntrospectChatId, makeIntrospectAgent } from '../companion/introspect-runtime'
import { makeMessagesStore } from '../../lib/messages-store'
import { recentInboundTexts } from './recent-inbound'
import { makeThreadsStore } from '../../lib/threads-store'
import { runThreadsExtraction } from '../threads/extractor'
import { runLocalImportIfEnabled } from '../local-import'
import { synthesizeOverview } from '../../lib/memory-synthesis'
import { makeLifeStoresReader } from '../life-stores'
import { runGarden } from '../memory/gardener'
import { readJsonFile } from '../../lib/read-json-file'
import { isNetworkUnprotectedError } from '../../lib/network-gate'
import type { TickDeps } from './tick-deps'
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

/**
 * 新贴纸那一句(觅食式表情生长)改走 SpeechPolicy(第三批 3a):别烦我 / 免打扰 / 都送不到由门判;
 * 图跟字走同一条路(微信发文件、App 记表情引用)。图发不出去 ⇒ 什么都不说,**不退成一句光秃秃的文字**(9d 评审)。
 * 贴纸已经在库里了,以后照样会用到;这一句只是「我画了张新的」的小报告,不补发。
 */
export async function announceNewSticker(
  d: { speech?: import('../speech/policy').SpeechPolicy; stickers: { resolve(tag: string): string | null }; log: (tag: string, line: string) => void },
  ownerChat: string,
  mood: string,
): Promise<void> {
  if (!d.speech) { d.log('STICKERS', 'new-sticker notice skipped: speech policy not wired'); return }
  const path = d.stickers.resolve(mood)
  if (!path) { d.log('STICKERS', `new-sticker notice skipped: no file for mood=${mood}`); return }
  const outcome = await d.speech.say({ kind: 'sticker', chatId: ownerChat }, async (turn) => {
    if (!(await turn.sendSticker(ownerChat, mood, path))) { d.log('STICKERS', `new-sticker notice not sent: sticker undeliverable (mood=${mood})`); return }
    await turn.sendText(ownerChat, `我画了张新表情!以后想说「${mood}」的时候就用它~`)
  })
  if (!('allow' in outcome)) d.log('STICKERS', `new-sticker notice ${'defer' in outcome ? 'deferred' : 'dropped'}: ${outcome.reason}`)
}

export function makeIntrospectTick(deps: TickDeps): (opts?: { nowIso?: string }) => Promise<void> {
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
      memorySnapshot: () => buildMemorySnapshot(deps.stateDir, chatId),
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
        await synthesizeOverview({ stateDir: deps.stateDir, adminChatId: chatId, sdkEval, lifeStores: makeLifeStoresReader(deps.db, deps.stateDir), includeFileSurvey: true })
        deps.log('SYNTHESIZE', `overview refreshed for ${chatId} (24h auto)`)
      } catch (err) {
        deps.log('SYNTHESIZE', `auto refresh failed: ${err instanceof Error ? err.message : err}`)
      }
    }

    // Memory gardener — daily curation pass over each chat's freeform memory
    // files (profile.md, preferences.md, notes/*.md). Same resolved sdkEval
    // as the steps above; isolated try/catch so a gardener failure cannot
    // break the rest of the tick. See docs/superpowers/specs/2026-07-10-
    // memory-gardener-design.md.
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

    // 觅食式表情生长 (2026-08-25) — once a day CC draws itself a sticker for
    // a mood the library doesn't cover yet, and announces it like a small
    // gift. Self-gating (22h marker + pool exhaustion) and every failure
    // mode non-fatal — see sticker-artist.ts.
    if (deps.stickers && sdkEval) {
      try {
        const { runStickerArtist } = await import('../sticker-artist')
        const ownerChat = loadCompanionConfig(deps.stateDir).default_chat_id
        await runStickerArtist({
          stateDir: deps.stateDir,
          lib: deps.stickers,
          cheapEval: sdkEval,
          log: (t, l) => deps.log(t, l),
          notify: (mood) => ownerChat ? announceNewSticker({ speech: deps.speech, stickers: deps.stickers!, log: deps.log }, ownerChat, mood) : Promise.resolve(),
        })
      } catch (err) {
        deps.log('STICKERS', `artist step failed: ${err instanceof Error ? err.message : err}`)
      }
    }

    // CC 画的你,慢慢长 (2026-08-27) — 档案比上次画像新且过了最短间隔时,
    // 静默重画小像。自我门控 + 每失败非致命,见 portrait-artist.ts。
    if (deps.generatePortrait) {
      try {
        const { runPortraitArtist } = await import('../portrait-artist')
        const { existsSync, readFileSync, statSync } = await import('node:fs')
        const ownerChat = loadCompanionConfig(deps.stateDir).default_chat_id
        if (ownerChat) {
          const memDir = join(deps.stateDir, 'memory', ownerChat)
          await runPortraitArtist({
            adminChatId: ownerChat,
            generate: deps.generatePortrait,
            portraitGeneratedAt: () => {
              try {
                const j = readJsonFile(join(memDir, 'portrait.json')) as { generated_at?: string }
                return j.generated_at ? Date.parse(j.generated_at) : null
              } catch { return null }
            },
            profileMtime: () => {
              let newest: number | null = null
              for (const f of ['_profile.json', '_overview.md', 'profile.md']) {
                const fp = join(memDir, f)
                if (existsSync(fp)) { const m = statSync(fp).mtimeMs; if (newest === null || m > newest) newest = m }
              }
              return newest
            },
            log: (t, l) => deps.log(t, l),
          })
        }
      } catch (err) {
        deps.log('PORTRAIT', `artist step failed: ${err instanceof Error ? err.message : err}`)
      }
    }

    try {
      const { gardened, skipped } = await runGarden({
        memoryRoot,
        archiveRoot: join(deps.stateDir, 'memory-archive'),
        stateFile: join(deps.stateDir, 'garden_state.json'),
        cheapEval: sdkEval,
        log: deps.log,
        today,
      })
      if (gardened > 0 || skipped > 0) {
        deps.log('GARDEN', `tick complete: gardened=${gardened} skipped=${skipped}`)
      }
    } catch (err) {
      deps.log('GARDEN', `tick failed: ${err instanceof Error ? err.message : err}`)
    }

    // CC Atelier is an optional, default-off extension point. The callback is
    // deliberately after introspection/gardening and isolated: no renderer or
    // planner failure may break the existing 24h maintenance tick.
    if (deps.runAtelierTick) {
      try {
        await deps.runAtelierTick({ nowIso })
      } catch (err) {
        deps.log('ATELIER', `tick failed: ${errMsg(err)}`)
      }
    }
  }

  return introspectTick
}
