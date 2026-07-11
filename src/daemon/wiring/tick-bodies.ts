/**
 * Companion scheduler tick bodies — pushTick (20m interval) + introspectTick (24h).
 *
 * Both have real branching logic (config gates, project resolution, store access),
 * so they earn their own file vs side-effects.ts which is pure helper factories.
 */
import { join } from 'node:path'
import type { Db } from '../../lib/db'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import { loadCompanionConfig, saveCompanionConfig } from '../companion/config'
import { buildMemorySnapshot } from '../memory/snapshot'
import { makeEventsStore } from '../events/store'
import { makeObservationsStore } from '../observations/store'
import { runIntrospectTick } from '../companion/introspect'
import { resolveIntrospectChatId, makeIntrospectAgent } from '../companion/introspect-runtime'
import { resolveEffectiveTier, TIER_PROFILES } from '../../core/user-tier'
import type { Access } from '../../lib/access'
import type { PermissionMode } from '../../core/capability-matrix'
import { makeMemoryFS } from '../memory/fs-api'
import { parseAgenda, selectDue, markResolved } from '../companion/agenda'
import { makeMessagesStore, type MessagesStore } from '../../lib/messages-store'
import { makeThreadsStore } from '../../lib/threads-store'
import { careLevel, shouldSpeak } from '../companion/calibration'
import type { CareLedger } from '../companion/care-ledger'
import { runThreadsExtraction } from '../threads/extractor'
import { runLocalImportIfEnabled } from '../local-import'
import { synthesizeOverview } from '../../lib/memory-synthesis'
import { makeLifeStoresReader } from '../life-stores'
import { loadPlugins, pluginMcpSpecs } from '../plugins/registry'
import { bundledPluginsDir } from '../plugins/paths'
import { createResilientBridge } from '../companion/ingest/bridge'
import { runIngestCycle, maxDecryptedMtime, ingestHasTool } from '../companion/ingest/cycle'
import selfPkg from '../../../package.json' with { type: 'json' }

/** Per-cycle wxfacts extraction batch cap (rate bound). */
export const INGEST_BATCH_CAP = 4
/** Skip an ingest cycle if any chat had inbound activity within this window (owner is actively chatting). */
export const INGEST_QUIET_MS = 3 * 60_000
import { runGarden } from '../memory/gardener'

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

export interface TickDeps {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  boot: Bootstrap
  /**
   * Task 11 — companion ticks aren't user-initiated, but the session
   * they acquire is still keyed by `chatId` (the configured
   * `default_chat_id`). Resolving the tier of that chat lets us reuse
   * the same per-chat session isolation as user-initiated dispatch.
   * Typically resolves to admin (operator's own chatId); a non-admin
   * `default_chat_id` is a misconfiguration the tick surfaces via log.
   */
  loadAccess: () => Access
  /**
   * Daemon-wide permission mode. When 'dangerously', the companion tick
   * promotes the resolved tier to admin so the operator's `--dangerously`
   * intent applies to background ticks as well as user-initiated dispatch.
   */
  permissionMode: PermissionMode
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /**
   * Task 6 — per-chat proactive-care preferences (care level) plus the set
   * of chat ids that have ever set a preference. pushTick sweeps
   * `[default_chat_id, ...chatPrefs.list()]` instead of only the owner's
   * chat. Typed as a structural subset of ChatPrefsStore so tests can fake
   * it without a full store.
   */
  chatPrefs: { get(chatId: string): { care?: 'off' | 'low' | 'high'; hunt?: boolean }; list(): string[] }
  /**
   * Task 6 — the calibration gate's learning signal (last claimed proactive
   * send + no-reply streak per chat). shouldSpeak() reads it; pushTick
   * claims it BEFORE dispatch, mirroring the agenda at-most-once contract.
   */
  careLedger: CareLedger
}

export interface TickBodies {
  /** WRITE-side knowledge ingestion (25m interval + new-message nudge). */
  ingestTick: () => Promise<void>
  pushTick: (opts?: { nowIso?: string }) => Promise<void>
  // introspect/observations internal timestamps stay wall-clock (MVP); nowIso
  // is only used to seed the memory gardener's `today` (archive filename /
  // watermark date), keeping the signature symmetric with pushTick.
  introspectTick: (opts?: { nowIso?: string }) => Promise<void>
}

export interface BuildPushTickTextOpts {
  nowIso: string
  defaultChatId: string
  /** The due intention body the tick is firing — the concrete reason to reach out. */
  intention: string
}

/**
 * Pure helper — assembles the push-tick envelope text. Extracted from
 * pushTick so the eval harness can drive the body with a virtual `ts`
 * without going through the scheduler. Production code path is unchanged.
 */
export function buildPushTickText(opts: BuildPushTickTextOpts): string {
  return (
    `<companion_tick ts="${opts.nowIso}" default_chat_id="${opts.defaultChatId}" />\n` +
    `有一条到点的跟进：「${opts.intention}」\n` +
    `先 memory_read 相关 .md，看看它是否还有意义、用户是不是已经自己说过结果。\n` +
    `默认就是发：调 reply 写一句简短、自然的问候（别催、别灌鸡汤）。晚了几天也照常发，自然带一句就行（"前两天那个…"），不用为迟到道歉。\n` +
    `"已过期"指这件事本身已经没意义了——约定的具体时刻早过去很久、或明显已无关；单纯晚几天不算过期。只有真的没意义、或用户已经自己说过结果，才不发——那就直接结束这一轮，不调用 reply，也不要产生任何 assistant text。`
  )
}

export interface BuildGapCheckinTextOpts {
  nowIso: string
  chatId: string
  /** Days since the last INBOUND message in this chat, floor'd. */
  daysSinceContact: number
}

/**
 * Pure helper — assembles the gap check-in envelope text (no due agenda
 * item; the calibration gate decided a quiet-days check-in is due instead).
 * Mirrors buildPushTickText's structure/extraction rationale.
 */
export function buildGapCheckinText(opts: BuildGapCheckinTextOpts): string {
  return (
    `<companion_tick ts="${opts.nowIso}" chat_id="${opts.chatId}" kind="gap" />\n` +
    `这是一次主动问候（距离上次对话 ${opts.daysSinceContact} 天）；` +
    `结合你对这位用户的了解，如果有自然的话头，用 reply 发**一条**简短自然的问候；` +
    `如果实在没有自然的话头，可以这次不发（直接结束这轮，不调用 reply 也没关系）。`
  )
}

/**
 * Pure helper — assembles the daily-hunt envelope text (no due agenda item;
 * the calibration gate decided a hunt is due for the owner's chat instead).
 * Mirrors buildGapCheckinText's structure/extraction rationale.
 */
export function buildHuntText(opts: { nowIso: string }): string {
  return (
    `<companion_tick ts="${opts.nowIso}" kind="hunt" />\n` +
    `每日打猎时间——回顾你记忆里主人的兴趣和最近关注，用网络工具（搜索/抓取）找新鲜的、他真会感兴趣的内容；` +
    `只挑真正值得的 1-2 条，用 reply 分享，每条一句"为什么你会感兴趣" + 链接；` +
    `如果今天没猎到值得分享的，可以不发（不调用 reply 直接结束）；` +
    `别分享你们最近已经聊过的东西。`
  )
}

export function buildTickBodies(deps: TickDeps): TickBodies {
  const launchCwd = process.cwd()

  // In-memory source-freshness marker for the ingest loop (deterministic
  // builders only run when the decrypted source advanced past this). Reset to 0
  // on restart → one catch-up build after a restart, which is harmless.
  let lastIngestSourceMtime = 0

  /**
   * WRITE-side knowledge ingestion. Drives the plugins' builders + wxfacts
   * extraction directly via the MCP bridge (no agent turn). Idle-gated (skips
   * when a chat is active), serialized under a dedicated `__ingest__` lock, and
   * an inert no-op when no knowledge plugins are loaded (e.g. e2e harness).
   */
  async function ingestTick(): Promise<void> {
    const specs = pluginMcpSpecs(loadPlugins({
      stateDir: deps.stateDir,
      bundledDir: bundledPluginsDir(),
      hostVersion: selfPkg.version,
    }))
    if (Object.keys(specs).length === 0) return   // no knowledge plugins → nothing to ingest

    // Don't compete with an active conversation. Two checks per known chat:
    // (1) authoritative — a turn is actually in-flight on its session (catches
    // long turns + proactive/converse dispatches that leave no inbound record);
    // (2) soft — an inbound arrived within the quiet window (give it a breather).
    // Concurrency matters: a live agent turn already runs its OWN plugin MCP
    // processes, so ingesting in parallel would open a second set on the same
    // sqlite (SQLITE_BUSY / lock contention).
    const messagesStore = makeMessagesStore(deps.db)
    const snapshot = deps.ilink.loadProjects()
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
        // watermark past them (silent loss). See ingestHasTool.
        const hasTool = ingestHasTool(bridge.tools.map(t => t.name), !!cheapEval)
        const report = await runIngestCycle({
          bridge,
          hasTool,
          cheapEval: cheapEval ?? (async () => '[]'),   // never invoked when extraction is gated off above
          sourceMaxMtime: () => maxDecryptedMtime(deps.stateDir),
          lastSourceMtime: lastIngestSourceMtime,
          cap: INGEST_BATCH_CAP,
          log: (tag, msg) => deps.log(tag, msg),
        })
        lastIngestSourceMtime = report.newSourceMtime
        if (report.batches || report.rebuilt || report.indexed || report.transcribed) {
          deps.log('INGEST', `cycle: decrypted=${report.decrypted} rebuilt=${report.rebuilt} indexed=${report.indexed} transcribed=${report.transcribed} batches=${report.batches} facts=${report.recorded}`)
        }
      } catch (err) {
        deps.log('INGEST', `cycle failed: ${errMsg(err)}`)
      } finally {
        await bridge.close()
      }
    })
  }

  /**
   * Resolves the chat's session (project/tier/provider), checks the
   * in-flight guard, acquires the handle, runs `claim()` (write the
   * at-most-once marker BEFORE dispatch — see the at-most-once note below),
   * then dispatches `buildText()`. Shared by the agenda and gap branches so
   * both get the same session-isolation + claim-before-dispatch contract.
   */
  async function dispatchToChat(
    chatId: string,
    args: { claim: () => void; buildText: () => string },
  ): Promise<void> {
    const snapshot = deps.ilink.loadProjects()
    const currentAlias = snapshot.current && snapshot.projects[snapshot.current] ? snapshot.current : null
    const proj = currentAlias
      ? { alias: currentAlias, path: snapshot.projects[currentAlias]!.path }
      : { alias: '_default', path: launchCwd }
    const tier = resolveEffectiveTier(chatId, deps.loadAccess(), deps.permissionMode)
    if (tier !== 'admin') {
      deps.log('COMPANION', `chat=${chatId} is non-admin tier (${tier}); push tick will run with reduced capabilities`)
    }
    const tierProfile = TIER_PROFILES[tier]
    // Dispatch on the chat's OWN mode provider (what its normal replies use),
    // not the daemon default. A codex-default install whose chat is solo-claude
    // would otherwise push via codex — a provider the chat never uses, which on
    // the Claude-designed companion prompt hangs and delivers nothing.
    const mode = deps.boot.coordinator.getMode(chatId)
    const providerId =
      mode.kind === 'solo' ? mode.provider
      : mode.kind === 'primary_tool' ? mode.primary
      : (mode.participants?.[0] ?? deps.boot.defaultProviderId)
    // Proactive fast-skip (TOCTOU-prone on its own, kept ABOVE the mutex
    // deliberately): avoids waiting on the lock in the common case where a
    // user session is obviously already busy. The runExclusive below closes
    // the residual race window this check alone can't — see the comment on
    // it just below.
    if (deps.boot.sessionManager.isInFlight({ alias: proj.alias, providerId, chatId })) {
      deps.log('SCHED', `[companion] skipping push tick: user session in-flight (alias=${proj.alias} provider=${providerId} chat=${chatId})`)
      return // leave the item pending — retry next tick
    }
    // Session-serialization (Task 3) — serialize the tick's acquire+claim+
    // dispatch against the SAME per-chatId mutex app converse turns
    // (companionConverse) and WeChat inbound turns (coordinator.dispatch)
    // use. Without this, the isInFlight check above is a TOCTOU: an app
    // turn opens its reply-sink AFTER its own (slower) manager.acquire, so
    // a tick could slip through in that window and have its reply captured
    // into the still-open app sink. The tick never calls
    // coordinator.dispatch/dispatchInner itself (it drives the
    // SessionManager handle directly), so this can never re-enter the
    // mutex and self-deadlock. See docs/superpowers/specs/2026-07-10-
    // session-serialization-design.md.
    await deps.boot.coordinator.runExclusive(chatId, async () => {
      const handle = await deps.boot.sessionManager.acquire({
        alias: proj.alias,
        path: proj.path,
        providerId,
        chatId,
        tierProfile,
        permissionMode: deps.permissionMode,
      })
      // Claim BEFORE dispatch — mark the send up front so a push that is
      // interrupted (machine sleeps mid-turn; daemon restart / lock-steal on
      // wake) cannot re-fire on the next tick. At-most-once: if the dispatch
      // then fails the nudge is simply skipped rather than retried — the
      // deliberate trade-off for proactive messages, where a duplicate is the
      // reported pain and a missed nudge is low-stakes (the agent can
      // re-author it, or the gap/agenda gate will surface it again later).
      // See docs/superpowers/specs/2026-06-25-companion-push-at-most-once-design.md
      args.claim()
      const tickText = args.buildText()
      try {
        for await (const _ev of handle.dispatch(tickText)) { /* drain */ }
      } catch (err) {
        deps.log('SCHED', `companion tick dispatch failed: ${errMsg(err)}`)
      }
    })
  }

  /**
   * Per-chat body: agenda branch (due self-authored intention) takes
   * priority; falls back to the gap check-in branch when nothing is due.
   * Both branches route through calibration's shouldSpeak() — the single
   * chokepoint every proactive send passes through.
   */
  async function pushTickForChat(
    chatId: string,
    ctx: { defaultChatId: string | undefined; nowIso: string; today: string; messagesStore: MessagesStore },
  ): Promise<void> {
    const { defaultChatId, nowIso, today, messagesStore } = ctx
    const level = careLevel(chatId, deps.chatPrefs.get(chatId), defaultChatId)
    if (level === 'off') return // care off = master proactive kill-switch: no agenda/gap/hunt sends (別烦我 silences everything); hunt's own pref only gates hunt within a care-enabled chat

    const lastInboundAtIso = (await messagesStore.latestInboundTs(chatId)) ?? undefined
    const ledger = deps.careLedger.get(chatId)

    // Gate on the agenda: only wake the agent if a self-authored intention is
    // due (per-chat memory/<chatId>/agenda.md).
    const agendaFs = makeMemoryFS({ rootDir: join(deps.stateDir, 'memory', chatId) })
    const agendaMd = agendaFs.read('agenda.md') ?? ''
    const due = selectDue(parseAgenda(agendaMd), today)

    if (due.length > 0) {
      // Fire the single oldest-due item this tick; the rest wait for later ticks.
      const item = [...due].sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0))[0]!
      const decision = shouldSpeak({ kind: 'agenda', level, nowIso, ledger, lastInboundAtIso })
      if (!decision.ok) {
        deps.log('CARE', `skip chat=${chatId} kind=agenda reason=${decision.reason}`)
        return
      }
      await dispatchToChat(chatId, {
        claim: () => {
          const updated = markResolved(agendaMd, item, today)
          if (updated !== agendaMd) agendaFs.write('agenda.md', updated)
          deps.careLedger.claim(chatId, nowIso)
        },
        buildText: () => buildPushTickText({ nowIso, defaultChatId: chatId, intention: item.body }),
      })
      return
    }

    // No due agenda item → hunt branch: only the owner's chat, once/day
    // (calibration cooldown). A cooling hunt must not block a legitimate
    // gap check-in, so a deny here falls through to the gap branch below
    // rather than returning.
    if (chatId === defaultChatId) {
      const huntLevel = deps.chatPrefs.get(chatId).hunt !== false ? 'low' as const : 'off' as const
      const huntDecision = shouldSpeak({ kind: 'hunt', level: huntLevel, nowIso, ledger, lastInboundAtIso })
      if (huntDecision.ok) {
        await dispatchToChat(chatId, {
          claim: () => { deps.careLedger.claimHunt(chatId, nowIso) },
          buildText: () => buildHuntText({ nowIso }),
        })
        return
      }
      deps.log('CARE', `skip chat=${chatId} kind=hunt reason=${huntDecision.reason}`)
    }

    // No due item → gap branch: has it been quiet long enough (by care
    // level) to warrant a check-in with no concrete agenda reason?
    const decision = shouldSpeak({ kind: 'gap', level, nowIso, ledger, lastInboundAtIso })
    if (!decision.ok) {
      deps.log('CARE', `skip chat=${chatId} kind=gap reason=${decision.reason}`)
      return
    }
    const daysSinceContact = lastInboundAtIso !== undefined
      ? Math.floor((Date.parse(nowIso) - Date.parse(lastInboundAtIso)) / 86_400_000)
      : 0
    await dispatchToChat(chatId, {
      claim: () => { deps.careLedger.claim(chatId, nowIso) },
      buildText: () => buildGapCheckinText({ nowIso, chatId, daysSinceContact }),
    })
  }

  async function pushTick(opts?: { nowIso?: string }): Promise<void> {
    const cfg = loadCompanionConfig(deps.stateDir)
    const nowIso = opts?.nowIso ?? new Date().toISOString()
    const today = nowIso.slice(0, 10)

    // Candidates: the owner's chat (if configured) plus every chat that has
    // ever set a care preference — ordered, deduped.
    const candidates: string[] = []
    if (cfg.default_chat_id) candidates.push(cfg.default_chat_id)
    for (const c of deps.chatPrefs.list()) {
      if (!candidates.includes(c)) candidates.push(c)
    }
    if (candidates.length === 0) { deps.log('SCHED', 'skip tick — no default_chat_id'); return }

    const messagesStore = makeMessagesStore(deps.db)

    // Sequential, one chat's error must not abort the others.
    for (const chatId of candidates) {
      try {
        await pushTickForChat(chatId, { defaultChatId: cfg.default_chat_id ?? undefined, nowIso, today, messagesStore })
      } catch (err) {
        deps.log('SCHED', `companion tick failed for chat=${chatId}: ${errMsg(err)}`)
      }
    }
  }

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
    const agent = makeIntrospectAgent({
      chatId, events, observations,
      memorySnapshot: () => buildMemorySnapshot(deps.stateDir, chatId),
      // Matches legacy main.ts v0.4.1 — recentInboundForChat() also returned [].
      recentInboundMessages: () => Promise.resolve([] as string[]),
      sdkEval,
    })
    // Isolated so a rare introspect-side throw (e.g. events.append db error)
    // cannot starve the threads extraction below — the two evals are
    // independent by design (spec D3).
    try {
      await runIntrospectTick({ events, observations, agent, chatId, log: deps.log })
      await saveCompanionConfig(deps.stateDir, { ...loadCompanionConfig(deps.stateDir), last_introspect_at: new Date().toISOString() })
    } catch (err) {
      deps.log('INTROSPECT', `tick failed: ${err instanceof Error ? err.message : err}`)
    }

    // Threads extraction — independent eval, same cheap model, same tick.
    // Run for every chat that has messages so other chats' conversations
    // also accumulate threads, not just the companion default_chat_id.
    // Parse failure per-chat is swallowed: watermark stays, retried next tick.
    // One-chat failure does not abort extraction for the remaining chats.
    const messagesStore = makeMessagesStore(deps.db)
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
  }

  return { ingestTick, pushTick, introspectTick }
}
