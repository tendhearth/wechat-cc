/**
 * 知识写入那一拍(25 分钟一拍 + 新消息时推一下)+ 主人知识蒸馏 / hearth 推送(从 tick-bodies.ts 原样搬出)。
 */
import { join } from 'node:path'
import { loadCompanionConfig } from '../companion/config'
import { makeMemoryFS } from '../../adapters/store/memory-fs'
import { makeMessagesStore } from '../../lib/messages-store'
import { loadPlugins, pluginMcpSpecs } from '../plugins/registry'
import { bundledPluginsDir } from '../plugins/paths'
import { createResilientBridge } from '../companion/ingest/bridge'
import { runIngestCycle, maxDecryptedMtime, ingestHasTool } from '../companion/ingest/cycle'
import { distillOwnerKnowledge } from '../companion/knowledge-distill'
import { connectHearth } from '../companion/hearth-client'
import { buildHearthPlan } from '../companion/hearth-plan'
import selfPkg from '../../../package.json' with { type: 'json' }
import type { TickDeps } from './tick-deps'
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

/** Per-cycle wxfacts extraction batch cap (rate bound). */
export const INGEST_BATCH_CAP = 4
/** Skip an ingest cycle if any chat had inbound activity within this window (owner is actively chatting). */
export const INGEST_QUIET_MS = 3 * 60_000

/**
 * D1 (knowledge distillation) + HI W3 (hearth push) — distill the owner's
 * kernel knowledge (facts + graph, in-process) into `knowledge.md`
 * (always-on memory; empty digest ⇒ remove a stale file), then optionally
 * push the SAME digest to an operator-configured `hearth` vault over MCP.
 *
 * Extracted from ingestTick's inline D1 block so it's directly unit-testable
 * — ingestTick's own pipeline goes through real plugin discovery
 * (`loadPlugins`/`createResilientBridge`), which in this repo's dev
 * checkout can find real bundled plugins on disk; exercising it end-to-end
 * in a test would mean spawning real MCP child processes. This function
 * needs only `deps.stateDir` + `deps.boot.knowledge` + `deps.log` (plus the
 * optional hearth seams), so tests can drive it directly.
 *
 * The hearth push is feature-gated + throw-safe by construction:
 *   - `connectHearth` (real impl, or `deps.hearthConnect` in tests) returns
 *     `null` — never throws — when `hearth_enabled` is off (the default) or
 *     hearth is unreachable. `null` ⇒ this whole block is a no-op, so
 *     feature-off is exactly today's behavior: only knowledge.md is
 *     written/removed.
 *   - Everything from `connectHearth` through `applyForOwner` runs inside
 *     its own try/catch: a malformed hearth MCP result (submit/
 *     applyForOwner's `JSON.parse` isn't internally guarded — see W1
 *     review) or any other hearth-side error is caught and logged here,
 *     never rethrown, so a hearth failure can never break the ingest tick.
 *   - `hearth.close()` always runs (finally), even when submit/apply threw.
 *   - A `requires_review` plan is submitted but left pending (not applied);
 *     otherwise it's auto-applied for the owner (channel `'wechat'`).
 */
export async function distillAndPushOwnerKnowledge(deps: TickDeps, ownerChat: string): Promise<void> {
  try {
    const digest = await distillOwnerKnowledge(deps.boot.knowledge)
    const fs = makeMemoryFS({ rootDir: join(deps.stateDir, 'memory', ownerChat) })
    // 内容没变就不写、不记(10-13:每轮 ~20 分钟都重写同样的 540 字并记一行,纯噪声)
    if (digest) { if (fs.read('knowledge.md') !== digest) { fs.write('knowledge.md', digest); deps.log('INGEST', `distilled knowledge.md for ${ownerChat} (${digest.length} chars)`) } }
    else if (fs.read('knowledge.md')) fs.delete('knowledge.md')

    try {
      const connect = deps.hearthConnect ?? connectHearth
      const cfg = loadCompanionConfig(deps.stateDir)
      const hearth = await connect(cfg, { log: (t, m) => deps.log(t, m) })
      if (hearth) {
        // `close()` sits in this `finally` (wrapping the whole `if (hearth)`
        // body, not just the submit/apply branch) so a connected client is
        // ALWAYS closed — including the empty-digest case below, where the
        // brief's own sketch would otherwise leak the connection by nesting
        // close() inside `if (hearth && digest)`.
        try {
          if (digest) {
            const buildPlan = deps.hearthBuildPlan ?? buildHearthPlan
            const plan = buildPlan(digest, Date.now())
            const { change_id, requires_review } = await hearth.submit(plan)
            if (requires_review) {
              deps.log('INGEST', `hearth: plan ${change_id} requires review — left pending`)
            } else {
              const r = await hearth.applyForOwner(change_id, ownerChat, 'wechat')
              deps.log('INGEST', `hearth: applied ${change_id} (ok=${r.ok})`)
            }
          }
        } finally {
          await hearth.close().catch(() => {})
        }
      }
    } catch (err) {
      deps.log('INGEST', `hearth push failed: ${errMsg(err)}`)
    }
  } catch (err) {
    deps.log('INGEST', `knowledge distill failed: ${errMsg(err)}`)
  }
}

export function makeIngestTick(deps: TickDeps): () => Promise<void> {
  // In-memory source-freshness marker for the ingest loop (deterministic
  // builders only run when the decrypted source advanced past this). Reset to 0
  // on restart → one catch-up build after a restart, which is harmless.
  let lastIngestSourceMtime = 0
  // Builder repeat-timeout damper — one map across all cycles (see
  // BUILDER_COOLDOWN_MS in cycle.ts for why: each failed attempt can hold
  // the __ingest__ exclusive slot for a full MCP request timeout).
  const ingestBuilderHealth = { fails: new Map<string, { n: number; skipUntil: number }>() }

  /**
   * WRITE-side knowledge ingestion. Drives the plugins' builders + wxfacts
   * extraction directly via the MCP bridge (no agent turn). Idle-gated (skips
   * when a chat is active), serialized under a dedicated `__ingest__` lock, and
   * an inert no-op when no knowledge plugins are loaded (e.g. e2e harness).
   */
  async function ingestTick(): Promise<void> {
    const specs = pluginMcpSpecs(loadPlugins({
      stateDir: deps.stateDir,
      bundledDir: bundledPluginsDir(deps.stateDir),
      hostVersion: selfPkg.version,
    }))
    // facts extraction now runs in-process (wxfacts plugin retired) — keep
    // ticking even with zero MCP knowledge plugins loaded when facts.db exists.
    const factsApi = deps.boot.knowledge?.facts
    if (Object.keys(specs).length === 0 && !factsApi) return   // nothing to ingest

    // Don't compete with an active conversation. Two checks per known chat:
    // (1) authoritative — a turn is actually in-flight on its session (catches
    // long turns + proactive/converse dispatches that leave no inbound record);
    // (2) soft — an inbound arrived within the quiet window (give it a breather).
    // Concurrency matters: a live agent turn already runs its OWN plugin MCP
    // processes, so ingesting in parallel would open a second set on the same
    // sqlite (SQLITE_BUSY / lock contention).
    const messagesStore = makeMessagesStore(deps.db)
    const snapshot = deps.projects.load()
    const alias = snapshot.current && snapshot.projects[snapshot.current] ? snapshot.current : '_default'
    try {
      const defaultChatId = loadCompanionConfig(deps.stateDir).default_chat_id
      const chatIds = new Set<string>(await messagesStore.listChatIds())
      if (defaultChatId) chatIds.add(defaultChatId)
      for (const chatId of chatIds) {
        const mode = deps.boot.coordinator.getMode(chatId)
        const providerId =
          mode.kind === 'solo' ? mode.provider
          : mode.kind === 'primary_tool' ? mode.primary
          : (mode.participants?.[0] ?? deps.boot.defaultProviderId)
        if (deps.boot.sessionManager.isInFlight({ alias, providerId, chatId })) {
          deps.log('INGEST', `skip cycle — session in-flight (chat ${chatId})`)
          return
        }
        const ts = await messagesStore.latestInboundTs(chatId)
        if (ts && Date.now() - Date.parse(ts) < INGEST_QUIET_MS) {
          deps.log('INGEST', `skip cycle — chat ${chatId} recently active`)
          return
        }
      }
    } catch (err) {
      deps.log('INGEST', `activity check failed (proceeding): ${errMsg(err)}`)
    }

    const cheapEval = deps.boot.registry.getCheapEval()
    await deps.boot.coordinator.runExclusive('__ingest__', async () => {
      // Resilient: connect per-plugin so a heavy source that fails to spawn
      // (wxsearch/wxmedia model loads) doesn't sink the whole cycle.
      const bridge = await createResilientBridge(specs, { log: (t, m) => deps.log(t, m) })
      try {
        // Gate extraction off when there's no cheap-eval provider — otherwise the
        // loop would drain real message windows into empty records + advance the
        // watermark past them (silent loss). See ingestHasTool. The in-proc
        // facts path bypasses hasTool (cycle.ts runs it unconditionally when
        // factsApi is set), so it needs the same cheapEval gate applied here.
        const hasTool = ingestHasTool(bridge.tools.map(t => t.name), !!cheapEval)
        const report = await runIngestCycle({
          bridge,
          hasTool,
          cheapEval: cheapEval ?? (async () => '[]'),   // never invoked when extraction is gated off above
          sourceMaxMtime: () => maxDecryptedMtime(deps.stateDir),
          lastSourceMtime: lastIngestSourceMtime,
          cap: INGEST_BATCH_CAP,
          log: (tag, msg) => deps.log(tag, msg),
          factsApi: cheapEval ? factsApi : undefined,
          builderHealth: ingestBuilderHealth,
        })
        lastIngestSourceMtime = report.newSourceMtime
        if (report.batches || report.rebuilt || report.indexed || report.transcribed) {
          deps.log('INGEST', `cycle: decrypted=${report.decrypted} rebuilt=${report.rebuilt} indexed=${report.indexed} transcribed=${report.transcribed} batches=${report.batches} facts=${report.recorded} settled=${report.settled}`)
        }
        // D1 — distill the owner's kernel knowledge (facts + graph, in-process)
        // into knowledge.md (always-on memory). Owner chat only (no chatId→name
        // join needed). Empty digest ⇒ remove the file so a stale one doesn't linger.
        const ownerChat = loadCompanionConfig(deps.stateDir).default_chat_id
        if (ownerChat && !ownerChat.includes('..') && !ownerChat.includes('/') && !ownerChat.includes('\\')) {
          await distillAndPushOwnerKnowledge(deps, ownerChat)
        }
      } catch (err) {
        deps.log('INGEST', `cycle failed: ${errMsg(err)}`)
      } finally {
        await bridge.close()
      }
    })
  }

  return ingestTick
}
