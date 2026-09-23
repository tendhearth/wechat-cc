import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeOutboundTaps } from '../outbound-taps'
import { buildTickBodies, buildPushTickText, buildGapCheckinText, buildHuntText, distillAndPushOwnerKnowledge, type TickDeps } from './tick-bodies'
import { TIER_PROFILES } from '../../core/user-tier'
import type { Access } from '../../lib/access'
import { openTestDb, type Db } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import type { CareLedgerEntry } from '../companion/calibration'
import type { CareLedger } from '../companion/care-ledger'
import { makeChatMutex, type ChatMutex } from '../../core/async-mutex'
import { readPlanLog } from '../companion/plan-memory'
import { formatLocal, PLAN_EVAL_TIMEOUT_MS } from '../../core/companion-plan'

/** Minimal in-memory fake of the structural chatPrefs subset TickDeps needs. */
function makeFakeChatPrefs(
  entries: Record<string, { care?: 'off' | 'low' | 'high'; hunt?: boolean; visit?: boolean }> = {},
): { get(chatId: string): { care?: 'off' | 'low' | 'high'; hunt?: boolean; visit?: boolean }; list(): string[] } {
  return {
    get: (chatId) => entries[chatId] ?? {},
    list: () => Object.keys(entries),
  }
}

/** Minimal in-memory fake CareLedger — mirrors makeCareLedger's semantics
 * (claim increments noReplyCount; tests that need a specific noReplyCount
 * pre-seed `entries` directly). */
function makeFakeCareLedger(entries: Record<string, CareLedgerEntry> = {}): CareLedger {
  return {
    get: (chatId) => entries[chatId] ?? { noReplyCount: 0 },
    claim: (chatId, nowIso) => {
      const cur = entries[chatId] ?? { noReplyCount: 0 }
      entries[chatId] = { ...cur, lastProactiveAtIso: nowIso, noReplyCount: cur.noReplyCount + 1 }
    },
    claimHunt: (chatId, nowIso) => {
      const cur = entries[chatId] ?? { noReplyCount: 0 }
      entries[chatId] = { ...cur, lastHuntAtIso: nowIso, noReplyCount: cur.noReplyCount + 1 }
    },
    claimVisit: (chatId, nowIso) => {
      const cur = entries[chatId] ?? { noReplyCount: 0 }
      entries[chatId] = { ...cur, lastVisitAtIso: nowIso, noReplyCount: cur.noReplyCount + 1 }
    },
    resetNoReply: (chatId) => {
      const cur = entries[chatId]
      if (cur) entries[chatId] = { ...cur, noReplyCount: 0 }
    },
  }
}

describe('buildPushTickText', () => {
  it('formats a push tick envelope with the supplied nowIso + chatId + intention', () => {
    const out = buildPushTickText({
      nowIso: '2026-05-13T01:30:00.000Z',
      defaultChatId: 'chat_test_1',
      intention: '跟进健身计划进展',
    })
    expect(out).toContain('<companion_tick ts="2026-05-13T01:30:00.000Z" default_chat_id="chat_test_1" />')
    expect(out).toContain('有一条到点的跟进：「跟进健身计划进展」')
    expect(out).toContain('不调用 reply')
    expect(out).toContain('memory_read')
    expect(out).toContain('不算过期')
    expect(out).toContain('晚了几天也照常发')
  })
})

describe('buildGapCheckinText', () => {
  it('formats a gap check-in envelope with the supplied nowIso + chatId + daysSinceContact', () => {
    const out = buildGapCheckinText({
      nowIso: '2026-05-16T01:30:00.000Z',
      chatId: 'chat_test_1',
      daysSinceContact: 3,
    })
    expect(out).toContain('<companion_tick ts="2026-05-16T01:30:00.000Z" chat_id="chat_test_1" kind="gap" />')
    expect(out).toContain('主动问候')
    expect(out).toContain('3 天')
    expect(out).toContain('reply')
    expect(out).toContain('这次不发')
  })
})

describe('buildHuntText', () => {
  it('formats a daily-hunt envelope with the supplied nowIso', () => {
    const out = buildHuntText({ nowIso: '2026-05-16T01:30:00.000Z' })
    expect(out).toContain('<companion_tick ts="2026-05-16T01:30:00.000Z" kind="hunt" />')
    expect(out).toContain('打猎')
    expect(out).toContain('值得')
    expect(out).toContain('reply')
    expect(out).toContain('不调用 reply')
  })
})

// Minimal pushTick test — verifies the PR D guard that companion ticks
// skip when the same (alias, providerId) session has an in-flight user
// dispatch. We mock only the surface tick-bodies touches.

function makeStateDir(cfg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tick-bodies-test-'))
  mkdirSync(join(dir, 'companion'), { recursive: true })
  writeFileSync(join(dir, 'companion', 'config.json'), JSON.stringify(cfg))
  return dir
}

interface Setup {
  stateDir: string
  acquire: ReturnType<typeof vi.fn>
  isInFlight: ReturnType<typeof vi.fn>
  dispatch: ReturnType<typeof vi.fn>
  logs: string[]
  deps: TickDeps
  db: Db
  chatPrefsEntries: Record<string, { care?: 'off' | 'low' | 'high'; hunt?: boolean; visit?: boolean }>
  careLedgerEntries: Record<string, CareLedgerEntry>
  /** Task 3 (session-serialization) — the fake coordinator's `runExclusive`
   * spy, backed by a REAL per-chatId async mutex (the same implementation
   * `createConversationCoordinator` uses), so tests can both assert the
   * tick routes through it AND hold the lock externally (simulating an
   * app/WeChat turn in flight) to prove the tick actually waits. */
  runExclusive: ReturnType<typeof vi.fn>
  coordinatorMutex: ChatMutex
}

function setupDeps(opts: {
  defaultChatId: string | null
  inFlight: boolean
  /** Optional Access stub. Defaults to admin tier for the configured chatId
   * so existing PR D tests keep their original expectations. */
  access?: Access
  /** Optional agenda.md content written to memory/<chatId>/agenda.md so the
   * agenda gate passes. Without this the tick returns early (no due items). */
  agendaMd?: string
  /** Daemon-wide default provider (agent-config.provider). Defaults to claude. */
  defaultProviderId?: string
  /** The chat's persisted Mode, returned by coordinator.getMode. Defaults to
   * solo on defaultProviderId — i.e. the chat answers under the daemon default. */
  mode?: { kind: 'solo'; provider: string } | { kind: 'primary_tool'; primary: string } | { kind: 'parallel'; participants?: string[] } | { kind: 'chatroom'; participants?: string[] }
  /** Task 6 — real sqlite db (all migrations applied) so pushTick's
   * makeMessagesStore(deps.db) call works. Pass one pre-seeded with rows
   * (via makeMessagesStore(db).append(...)) to drive the gap branch;
   * otherwise a fresh empty db is opened. */
  db?: Db
  /** Task 6 — chat-prefs entries. Keys double as chatPrefs.list() — i.e.
   * every chat that has ever set a preference (not just non-default ones). */
  chatPrefsEntries?: Record<string, { care?: 'off' | 'low' | 'high'; hunt?: boolean; visit?: boolean }>
  /** Task 6 — care-ledger entries, keyed by chatId. */
  careLedgerEntries?: Record<string, CareLedgerEntry>
}): Setup {
  const stateDir = makeStateDir({
    enabled: true,
    ...(opts.defaultChatId ? { default_chat_id: opts.defaultChatId } : {}),
  })
  if (opts.agendaMd !== undefined && opts.defaultChatId) {
    const memDir = join(stateDir, 'memory', opts.defaultChatId)
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'agenda.md'), opts.agendaMd)
  }
  const logs: string[] = []
  const db = opts.db ?? openTestDb()
  const chatPrefsEntries = opts.chatPrefsEntries ?? {}
  const careLedgerEntries = opts.careLedgerEntries ?? {}
  // dispatch returns AsyncIterable<AgentEvent>, not a Promise — the real
  // contract. Mocking as `Promise<void>` would mask the bug that pushTick
  // was awaiting the iterable directly without iterating (PR D fix).
  const dispatch = vi.fn(() => ({
    async *[Symbol.asyncIterator]() { /* empty turn — no events */ },
  }))
  const acquire = vi.fn(async () => ({
    alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
    dispatch, close: async () => {},
  }))
  const isInFlight = vi.fn(() => opts.inFlight)
  const defaultProviderId = opts.defaultProviderId ?? 'claude'
  const mode = opts.mode ?? { kind: 'solo' as const, provider: defaultProviderId }
  const getMode = vi.fn(() => mode)
  // Task 3 — real pass-through mutex (same impl the coordinator uses), so
  // the tick's runExclusive(chatId, ...) call genuinely serializes against
  // anything else holding the lock for the same chatId in a test.
  const coordinatorMutex = makeChatMutex()
  const runExclusive = vi.fn((chatId: string, fn: () => Promise<unknown>) => coordinatorMutex.runExclusive(chatId, fn))
  const defaultAccess: Access = {
    dmPolicy: 'allowlist',
    allowFrom: opts.defaultChatId ? [opts.defaultChatId] : [],
    ...(opts.defaultChatId ? { admins: [opts.defaultChatId] } : {}),
  }
  const access = opts.access ?? defaultAccess
  const deps: TickDeps = {
    stateDir,
    db,
    ilink: {
      loadProjects: () => ({ projects: {}, current: null }),
    } as never,
    boot: {
      sessionManager: { acquire, isInFlight } as never,
      defaultProviderId: defaultProviderId as never,
      coordinator: { getMode, runExclusive } as never,
      // Default: no provider has cheapEval. Introspect-specific tests
      // override via deps.boot.registry directly.
      registry: { getCheapEval: () => null } as never,
    } as never,
    loadAccess: () => access,
    permissionMode: 'strict',
    log: (tag, line) => { logs.push(`${tag}|${line}`) },
    chatPrefs: makeFakeChatPrefs(chatPrefsEntries),
    careLedger: makeFakeCareLedger(careLedgerEntries),
  }
  return { stateDir, acquire, isInFlight, dispatch, logs, deps, db, chatPrefsEntries, careLedgerEntries, runExclusive, coordinatorMutex }
}

/** 串门用的 penpal 假件。原本长在打猎那个 describe 里,日程判断也要用,提到模块作用域。 */
const withVisit = (s: Setup, opts: { hasOpen: boolean; result?: { ok: true; id: string; channel: string } | { ok: false; reason: string } }) => {
  const startVisit = vi.fn(async () => opts.result ?? { ok: true as const, id: 'v1', channel: 'ch' })
  ;(s.deps.boot as unknown as { social: unknown }).social = {
    penpal: { startVisit, channelStore: { list: () => (opts.hasOpen ? [{ id: 'ch', status: 'open' }] : []) } },
  }
  return startVisit
}

describe('buildTickBodies / pushTick — companion isolation (PR D)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('skips the tick when the resolved session has an in-flight dispatch', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: true,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.isInFlight).toHaveBeenCalledWith({ alias: '_default', providerId: 'claude', chatId: 'chat-1' })
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('skipping push tick: user session in-flight'))).toBe(true)
  })

  it('proceeds when no in-flight dispatch on the session', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.isInFlight).toHaveBeenCalledWith({ alias: '_default', providerId: 'claude', chatId: 'chat-1' })
    expect(s.acquire).toHaveBeenCalledOnce()
    expect(s.dispatch).toHaveBeenCalledOnce()
  })

  it('dispatches on the chat\'s own mode provider, not the daemon default', async () => {
    // Daemon default is codex, but THIS chat is solo-claude (user runs /cc).
    // The proactive push must follow the chat's mode, else it dispatches to a
    // provider the chat never uses (the real bug: codex hung, nothing delivered).
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
      defaultProviderId: 'codex',
      mode: { kind: 'solo', provider: 'claude' },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.isInFlight).toHaveBeenCalledWith({ alias: '_default', providerId: 'claude', chatId: 'chat-1' })
    expect(s.acquire).toHaveBeenCalledOnce()
    expect(s.acquire.mock.calls[0]![0]).toMatchObject({ providerId: 'claude' })
  })

  it('primary_tool chat dispatches on its primary provider', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
      defaultProviderId: 'codex',
      mode: { kind: 'primary_tool', primary: 'claude' },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.acquire.mock.calls[0]![0]).toMatchObject({ providerId: 'claude' })
  })

  it('skips before checking in-flight when default_chat_id is unset', async () => {
    const s = setupDeps({ defaultChatId: null, inFlight: false })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick()
    expect(s.isInFlight).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
  })

  it('returns silently without an LLM call when no agenda.md exists', async () => {
    // No agendaMd supplied → no agenda.md file → no due items → falls
    // through to the hunt branch (disabled here via prefs so this test can
    // keep pinning the pre-hunt gap fallback in isolation — see the
    // dedicated "daily hunt" describe block below for hunt coverage), then
    // the gap branch, which denies (no inbound message ever seen ⇒
    // 'never_talked') without touching session/dispatch.
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false, chatPrefsEntries: { 'chat-1': { hunt: false } } })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.isInFlight).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('CARE') && l.includes('reason=never_talked'))).toBe(true)
  })

  it('returns silently when agenda.md has only future items', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-12-31 far future item',
      // hunt disabled — see comment on the preceding test.
      chatPrefsEntries: { 'chat-1': { hunt: false } },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.isInFlight).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('CARE') && l.includes('reason=never_talked'))).toBe(true)
  })
})

describe('buildTickBodies / pushTick — routes claim+dispatch through the per-chat mutex (Task 3, session-serialization)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('claim+dispatch run inside coordinator.runExclusive(chatId, ...)', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    // The tick claimed the mutex for the chat it dispatched to, and did so
    // BEFORE acquire/claim/dispatch ran (asserted via ordering below).
    expect(s.runExclusive).toHaveBeenCalledWith('chat-1', expect.any(Function))
    expect(s.acquire).toHaveBeenCalledOnce()
    expect(s.dispatch).toHaveBeenCalledOnce()
    const runExclusiveOrder = s.runExclusive.mock.invocationCallOrder[0]!
    const acquireOrder = s.acquire.mock.invocationCallOrder[0]!
    const dispatchOrder = s.dispatch.mock.invocationCallOrder[0]!
    expect(runExclusiveOrder).toBeLessThan(acquireOrder)
    expect(acquireOrder).toBeLessThan(dispatchOrder)
  })

  it('does not start acquire/dispatch until a same-chat runExclusive lock (simulating an in-flight app turn) is released', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false, // the cheap isInFlight pre-check does NOT see this app turn — only the mutex does
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)

    // Simulate an app converse turn already holding the mutex for this chat
    // (mirrors pipeline-deps.ts's companionConverse: runExclusive wraps its
    // whole reply-sink-open→dispatch→close lifetime).
    let releaseHeldTurn!: () => void
    const heldTurnDone = new Promise<void>(resolve => { releaseHeldTurn = resolve })
    const holdPromise = s.coordinatorMutex.runExclusive('chat-1', () => heldTurnDone)

    const { pushTick } = buildTickBodies(s.deps)
    const tickPromise = pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })

    // Give pending microtasks a chance to run — the tick should be blocked
    // on the mutex, so acquire/dispatch must NOT have run yet.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.dispatch).not.toHaveBeenCalled()

    // Release the held "app turn" — the tick's runExclusive callback can now run.
    releaseHeldTurn()
    await holdPromise
    await tickPromise

    expect(s.acquire).toHaveBeenCalledOnce()
    expect(s.dispatch).toHaveBeenCalledOnce()
  })
})

describe('buildTickBodies / pushTick — companion default_chat_id + tier (Task 11)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('pushTick acquires with companion default_chat_id and admin tier resolved from access.json', async () => {
    const access: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['ownerChat'],
      admins: ['ownerChat'],
    }
    const s = setupDeps({
      defaultChatId: 'ownerChat',
      inFlight: false,
      access,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.acquire).toHaveBeenCalledOnce()
    const req = s.acquire.mock.calls[0]?.[0] as { chatId: string; tierProfile: unknown }
    expect(req.chatId).toBe('ownerChat')
    expect(req.tierProfile).toBe(TIER_PROFILES.admin)
    // Admin path: no COMPANION warning should fire.
    expect(s.logs.some(l => l.startsWith('COMPANION|'))).toBe(false)
  })

  it('pushTick with non-admin default_chat_id resolves to guest tier and logs a COMPANION warning', async () => {
    const access: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['nonadmin'],
      admins: ['someone-else'],
    }
    const s = setupDeps({
      defaultChatId: 'nonadmin',
      inFlight: false,
      access,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.acquire).toHaveBeenCalledOnce()
    const req = s.acquire.mock.calls[0]?.[0] as { chatId: string; tierProfile: unknown }
    expect(req.chatId).toBe('nonadmin')
    expect(req.tierProfile).toBe(TIER_PROFILES.guest)
    // Non-admin tier surfaces a single COMPANION log line — a real
    // operator-misconfiguration signal that the tick fires under reduced
    // capabilities.
    expect(s.logs.some(l => l.startsWith('COMPANION|') && l.includes('non-admin') && l.includes('guest'))).toBe(true)
  })

  it('pushTick with trusted default_chat_id resolves to trusted tier and logs a COMPANION warning', async () => {
    const access: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['trustyChat'],
      trusted: ['trustyChat'],
    }
    const s = setupDeps({
      defaultChatId: 'trustyChat',
      inFlight: false,
      access,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.acquire).toHaveBeenCalledOnce()
    const req = s.acquire.mock.calls[0]?.[0] as { chatId: string; tierProfile: unknown }
    expect(req.tierProfile).toBe(TIER_PROFILES.trusted)
    expect(s.logs.some(l => l.startsWith('COMPANION|') && l.includes('trusted'))).toBe(true)
  })
})

describe('buildTickBodies / pushTick — at-most-once dedup on sleep/wake', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  const agendaPath = (stateDir: string, chatId: string) =>
    join(stateDir, 'memory', chatId, 'agenda.md')

  // A dispatch that throws partway, simulating the machine sleeping mid-turn
  // (the proactive message already went out, then the turn errors on wake) —
  // or the daemon being restarted before the post-dispatch mark could land.
  const throwingDispatch = () => ({
    async *[Symbol.asyncIterator]() { throw new Error('stream idle timeout (slept mid-turn)') },
  })

  it('does not re-push a due intention whose first dispatch was interrupted', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 ping me about the gym',
      // Hunt disabled — the second tick (agenda now resolved) would
      // otherwise fall into the hunt branch and dispatch a second time,
      // which is not what this test is pinning (agenda at-most-once).
      chatPrefsEntries: { 'chat-1': { hunt: false } },
    })
    cleanup.push(s.stateDir)
    s.dispatch.mockImplementationOnce(throwingDispatch)
    const { pushTick } = buildTickBodies(s.deps)

    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' }) // push goes out, then turn errors
    await pushTick({ nowIso: '2026-05-13T10:20:00.000Z' }) // wake/restart re-trigger

    // The intention was claimed BEFORE dispatch, so the second tick finds it
    // resolved and does not push again. dispatch ran exactly once (first tick).
    expect(s.dispatch).toHaveBeenCalledOnce()
  })

  it('marks the intention resolved even when dispatch throws (at-most-once)', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 ping me about the gym',
    })
    cleanup.push(s.stateDir)
    s.dispatch.mockImplementationOnce(throwingDispatch)
    const { pushTick } = buildTickBodies(s.deps)

    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })

    const content = readFileSync(agendaPath(s.stateDir, 'chat-1'), 'utf8')
    expect(content).toContain('- [x] done:2026-05-13 ping me about the gym')
    expect(content).not.toContain('- [ ] due:2026-05-13 ping me about the gym')
  })

  it('preserves an intention the agent appends to agenda.md during dispatch', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 ping me about the gym',
    })
    cleanup.push(s.stateDir)
    const file = agendaPath(s.stateDir, 'chat-1')
    // The agent edits agenda.md mid-dispatch (adds a fresh intention). Because
    // the fired item is already marked before dispatch and we never write again
    // after, the agent's addition must survive.
    s.dispatch.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        writeFileSync(file, readFileSync(file, 'utf8') + '\n- [ ] due:2026-06-01 follow up later')
      },
    }))
    const { pushTick } = buildTickBodies(s.deps)

    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })

    const content = readFileSync(file, 'utf8')
    expect(content).toContain('- [x] done:2026-05-13 ping me about the gym')
    expect(content).toContain('- [ ] due:2026-06-01 follow up later')
  })

  it('does not touch agenda.md on the in-flight early-return path', async () => {
    const original = '- [ ] due:2026-05-13 ping me about the gym'
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: true, agendaMd: original })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)

    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })

    expect(readFileSync(agendaPath(s.stateDir, 'chat-1'), 'utf8')).toBe(original)
  })
})

describe('buildTickBodies / pushTick — multi-chat care sweep (Task 6)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  const agendaPath = (stateDir: string, chatId: string) =>
    join(stateDir, 'memory', chatId, 'agenda.md')

  it('(a) owner chat with a due agenda item is dispatched, agenda marked resolved, ledger claimed', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.dispatch).toHaveBeenCalledOnce()
    expect(readFileSync(agendaPath(s.stateDir, 'chat-1'), 'utf8')).toContain('- [x] done:2026-05-13 check in on project')
    expect(s.careLedgerEntries['chat-1']?.lastProactiveAtIso).toBe('2026-05-13T10:00:00.000Z')
  })

  it('(b) care:high chat with no agenda + lastInbound 3 days ago + no prior proactive ⇒ gap dispatched, text contains 天', async () => {
    const db = openTestDb()
    const ms = makeMessagesStore(db)
    await ms.append({ id: 'm1', chatId: 'chat-2', ts: '2026-05-13T10:00:00.000Z', direction: 'in', kind: 'text', text: 'hi', source: 'live' })
    const s = setupDeps({
      defaultChatId: null,
      inFlight: false,
      db,
      chatPrefsEntries: { 'chat-2': { care: 'high' } },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-16T10:00:00.000Z' })
    expect(s.dispatch).toHaveBeenCalledOnce()
    expect(s.acquire.mock.calls[0]![0]).toMatchObject({ chatId: 'chat-2' })
    const text = s.dispatch.mock.calls[0]![0] as string
    expect(text).toContain('天')
    expect(s.careLedgerEntries['chat-2']?.lastProactiveAtIso).toBe('2026-05-16T10:00:00.000Z')
  })

  it('(c) same chat with noReplyCount:2 is NOT dispatched, log contains paused_no_reply', async () => {
    const db = openTestDb()
    const ms = makeMessagesStore(db)
    await ms.append({ id: 'm1', chatId: 'chat-2', ts: '2026-05-13T10:00:00.000Z', direction: 'in', kind: 'text', text: 'hi', source: 'live' })
    const s = setupDeps({
      defaultChatId: null,
      inFlight: false,
      db,
      chatPrefsEntries: { 'chat-2': { care: 'high' } },
      careLedgerEntries: { 'chat-2': { noReplyCount: 2 } },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-16T10:00:00.000Z' })
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('CARE') && l.includes('paused_no_reply'))).toBe(true)
  })

  it('(d) chat with prefs set but care unset (non-owner) is untouched — no dispatch, no log', async () => {
    const s = setupDeps({
      defaultChatId: null,
      inFlight: false,
      chatPrefsEntries: { 'chat-3': {} },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-16T10:00:00.000Z' })
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('chat-3'))).toBe(false)
  })

  it('(e) no default_chat_id + no care prefs ⇒ zero dispatches (e2e-silence invariant)', async () => {
    const s = setupDeps({ defaultChatId: null, inFlight: false })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-16T10:00:00.000Z' })
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.isInFlight).not.toHaveBeenCalled()
  })

  it('(f) owner agenda item but ledger lastProactive 1h ago ⇒ skipped, log agenda_cooldown', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
      careLedgerEntries: { 'chat-1': { lastProactiveAtIso: '2026-05-13T09:00:00.000Z', noReplyCount: 0 } },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' }) // 1h after lastProactiveAtIso, < 20h cooldown
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('CARE') && l.includes('agenda_cooldown'))).toBe(true)
  })
})

describe('buildTickBodies / pushTick — daily hunt branch (Task 3)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('(a) owner, no agenda, hunt unset, no lastHuntAtIso ⇒ hunt dispatched (text has 打猎/值得), ledger claimed', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.dispatch).toHaveBeenCalledOnce()
    const text = s.dispatch.mock.calls[0]![0] as string
    expect(text).toContain('打猎')
    expect(text).toContain('值得')
    // Claimed BEFORE dispatch is guaranteed by dispatchToChat's shared
    // claim-then-dispatch contract (see the at-most-once tests above for
    // the interrupted-dispatch proof); here we assert both the ledger
    // write and the dispatch happened.
    expect(s.careLedgerEntries['chat-1']?.lastHuntAtIso).toBe('2026-05-13T10:00:00.000Z')
  })

  it('打猎轮次持 busy token(label=hunt),发完释放 —— 桌宠靠它显示「觅食中」', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const held: string[] = []
    let released = 0
    let heldDuringDispatch = false
    s.deps.boot = { ...s.deps.boot, holdBusy: (label: string) => { held.push(label); return () => { released++ } } } as never
    s.dispatch.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() { heldDuringDispatch = held.includes('hunt') && released === 0 },
    }))
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(held).toEqual(['hunt'])
    expect(heldDuringDispatch).toBe(true)
    expect(released).toBe(1)
  })

  // ── 战利品入库(2026-09-03,用户反馈「桌面端没有记录」)────────────
  //
  // 这条链最容易「静默不记」:tap 没开、tap 和发送不是同一个实例、或者
  // 记录抛异常把整拍带崩 —— 三种都不会有任何报错,只是清单永远空着。

  it('打猎发出去的东西进战利品清单', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const recorded: Array<{ chatId: string; text: string }> = []
    const taps = makeOutboundTaps()
    // dispatch 期间模拟 reply 路由往 tap 里写(真实链路上是 internal-api)。
    s.dispatch.mockImplementation(async function* () { taps.observe('chat-1', '看这个 https://a.com') })
    const { pushTick } = buildTickBodies({
      ...s.deps,
      outboundTaps: taps,
      huntStore: { recordHunt: (a) => { recorded.push({ chatId: a.chatId, text: a.text }); return 1 } },
    })
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(recorded).toEqual([{ chatId: 'chat-1', text: '看这个 https://a.com' }])
  })

  it('**这一拍什么都没发时不记空条目** —— 打猎允许「今天没猎到」', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const recordHunt = vi.fn(() => 0)
    await buildTickBodies({ ...s.deps, outboundTaps: makeOutboundTaps(), huntStore: { recordHunt } })
      .pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(recordHunt).not.toHaveBeenCalled()
  })

  it('**入库抛异常不能让这一拍看起来失败** —— 消息已经发出去了', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const taps = makeOutboundTaps()
    s.dispatch.mockImplementation(async function* () { taps.observe('chat-1', '看这个 https://a.com') })
    const { pushTick } = buildTickBodies({
      ...s.deps,
      outboundTaps: taps,
      huntStore: { recordHunt: () => { throw new Error('db locked') } },
    })
    await expect(pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })).resolves.toBeUndefined()
    expect(s.logs.some(l => l.includes('入库失败'))).toBe(true)
  })

  it('没接 store 时是旧行为(发了不记),不报错', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    await expect(buildTickBodies(s.deps).pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })).resolves.toBeUndefined()
    expect(s.dispatch).toHaveBeenCalledOnce()
  })

  // ── 串门 tick(2026-09-03)──────────────────────────────────────────
  it('打猎刚出过门(冷却中)、有开着的信道 ⇒ 这一拍去串门,并登记 lastVisitAtIso', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1', inFlight: false,
      careLedgerEntries: { 'chat-1': { lastHuntAtIso: '2026-05-13T09:00:00.000Z', noReplyCount: 0 } },
    })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: true })
    await buildTickBodies(s.deps).pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(startVisit).toHaveBeenCalledOnce()
    expect(s.careLedgerEntries['chat-1']?.lastVisitAtIso).toBe('2026-05-13T10:00:00.000Z')
    expect(s.dispatch).not.toHaveBeenCalled() // 串门不是 agent turn
  })

  it('**打猎和串门不在同一拍**:打猎能出门时先打猎并 return,串门等下一拍', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: true })
    await buildTickBodies(s.deps).pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.dispatch).toHaveBeenCalledOnce()       // 打猎
    expect(startVisit).not.toHaveBeenCalled()        // 串门没出
  })

  it('串门冷却中 ⇒ 不出门,记 visit_cooldown', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1', inFlight: false,
      careLedgerEntries: { 'chat-1': { lastHuntAtIso: '2026-05-13T09:00:00.000Z', lastVisitAtIso: '2026-05-13T09:30:00.000Z', noReplyCount: 0 } },
    })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: true })
    await buildTickBodies(s.deps).pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(startVisit).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('kind=visit') && l.includes('visit_cooldown'))).toBe(true)
  })

  it('没有开着的真信道也出门 —— 总有邻居家可去(startVisit 自己挑)', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1', inFlight: false,
      careLedgerEntries: { 'chat-1': { lastHuntAtIso: '2026-05-13T09:00:00.000Z', noReplyCount: 0 } },
    })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: false, result: { ok: true, id: 'v1', channel: 'neighbor:ayou' } })
    await buildTickBodies(s.deps).pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(startVisit).toHaveBeenCalledOnce()
    expect(s.careLedgerEntries['chat-1']?.lastVisitAtIso).toBe('2026-05-13T10:00:00.000Z')
  })

  it('/set visit off ⇒ 不出门', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1', inFlight: false,
      chatPrefsEntries: { 'chat-1': { visit: false } },
      careLedgerEntries: { 'chat-1': { lastHuntAtIso: '2026-05-13T09:00:00.000Z', noReplyCount: 0 } },
    })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: true })
    await buildTickBodies(s.deps).pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(startVisit).not.toHaveBeenCalled()
  })

  it('主人两次不回 ⇒ 串门也暂停(别在人不想理你时讲今天的事)', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1', inFlight: false,
      careLedgerEntries: { 'chat-1': { lastHuntAtIso: '2026-05-13T09:00:00.000Z', noReplyCount: 2 } },
    })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: true })
    await buildTickBodies(s.deps).pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(startVisit).not.toHaveBeenCalled()
  })

  it('社交未接线(boot.social 缺失)⇒ 旧行为,什么都不发生', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1', inFlight: false,
      careLedgerEntries: { 'chat-1': { lastHuntAtIso: '2026-05-13T09:00:00.000Z', noReplyCount: 0 } },
    })
    cleanup.push(s.stateDir)
    await expect(buildTickBodies(s.deps).pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })).resolves.toBeUndefined()
  })

  it('(b) lastHuntAtIso 1h ago ⇒ hunt skipped (hunt_cooldown), falls through to gap evaluation', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      careLedgerEntries: { 'chat-1': { lastHuntAtIso: '2026-05-13T09:00:00.000Z', noReplyCount: 0 } },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('CARE') && l.includes('kind=hunt') && l.includes('reason=hunt_cooldown'))).toBe(true)
    // Fell through to the gap branch (no inbound message ever seen here ⇒ never_talked).
    expect(s.logs.some(l => l.includes('CARE') && l.includes('kind=gap') && l.includes('reason=never_talked'))).toBe(true)
  })

  it('(c) prefs.hunt:false ⇒ no hunt (care_off), falls through to gap evaluation', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      chatPrefsEntries: { 'chat-1': { hunt: false } },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('CARE') && l.includes('kind=hunt') && l.includes('reason=care_off'))).toBe(true)
    expect(s.logs.some(l => l.includes('CARE') && l.includes('kind=gap') && l.includes('reason=never_talked'))).toBe(true)
  })

  it('(d) non-owner care-enabled chat never hunts, even with hunt pref unset', async () => {
    const db = openTestDb()
    const ms = makeMessagesStore(db)
    await ms.append({ id: 'm1', chatId: 'chat-2', ts: '2026-05-13T10:00:00.000Z', direction: 'in', kind: 'text', text: 'hi', source: 'live' })
    const s = setupDeps({
      defaultChatId: null,
      inFlight: false,
      db,
      chatPrefsEntries: { 'chat-2': { care: 'high' } },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-16T10:00:00.000Z' })
    // Gap fires (as in the multi-chat sweep test above) but it must never be
    // the hunt text, and no hunt log line should appear for a non-owner chat.
    expect(s.dispatch).toHaveBeenCalledOnce()
    const text = s.dispatch.mock.calls[0]![0] as string
    expect(text).not.toContain('打猎')
    expect(s.logs.some(l => l.includes('kind=hunt'))).toBe(false)
    expect(s.careLedgerEntries['chat-2']?.lastHuntAtIso).toBeUndefined()
  })

  it('(e) agenda due ⇒ agenda fires, hunt not attempted', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.dispatch).toHaveBeenCalledOnce()
    const text = s.dispatch.mock.calls[0]![0] as string
    expect(text).not.toContain('打猎')
    expect(s.logs.some(l => l.includes('kind=hunt'))).toBe(false)
    expect(s.careLedgerEntries['chat-1']?.lastHuntAtIso).toBeUndefined()
  })

  it('(f) noReplyCount:2 ⇒ hunt paused_no_reply', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      careLedgerEntries: { 'chat-1': { noReplyCount: 2 } },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('CARE') && l.includes('kind=hunt') && l.includes('reason=paused_no_reply'))).toBe(true)
  })

  it('(g) care:off + hunt:true ⇒ care=off is master switch, zero dispatches (hunt suppressed by care)', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      chatPrefsEntries: { 'chat-1': { care: 'off', hunt: true } },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    // care=off early-return means ZERO dispatches: no hunt, no gap, no agenda.
    expect(s.dispatch).not.toHaveBeenCalled()
    // Hunt-specific log should not exist at all (the early-return prevents
    // reaching the hunt branch).
    expect(s.logs.some(l => l.includes('kind=hunt'))).toBe(false)
    expect(s.logs.some(l => l.includes('kind=gap'))).toBe(false)
    expect(s.careLedgerEntries['chat-1']?.lastHuntAtIso).toBeUndefined()
  })
})

describe('buildTickBodies / pushTick — connection health gate (Task 4)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  // The LLM-turn spy is `s.dispatch` — the session handle's dispatch()
  // returned by `acquire()`, which dispatchToChat drives via
  // `for await (const _ev of handle.dispatch(tickText))`. That call IS the
  // agent turn (it's what actually invokes the LLM); asserting it was never
  // called proves no LLM round-trip happened, not merely that no message
  // reached WeChat. `coordinator` in this file has no `dispatch` field
  // (only `getMode`/`runExclusive`), so the brief's draft spy name doesn't
  // apply here — this is the real one.

  it('wechat degraded 时不发主动消息,而且不调 LLM', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false, agendaMd: '- [ ] due:2026-05-13 check in on project' })
    cleanup.push(s.stateDir)
    const shouldSuspend = vi.fn(() => true)
    const { pushTick } = buildTickBodies({ ...s.deps, health: { shouldSuspend } })
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    // "省 token" 断言:LLM 轮次(session handle 的 dispatch)根本没被发起。
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
    expect(shouldSuspend).toHaveBeenCalledWith('wechat')
    expect(s.logs.some(l => l.includes('COMPANION') && l.includes('degraded'))).toBe(true)
  })

  it('healthy 时照常发', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false, agendaMd: '- [ ] due:2026-05-13 check in on project' })
    cleanup.push(s.stateDir)
    const shouldSuspend = vi.fn(() => false)
    const { pushTick } = buildTickBodies({ ...s.deps, health: { shouldSuspend } })
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.dispatch).toHaveBeenCalledOnce()
  })

  it('health 未提供(省略)时永不暂停 —— 既有测试与 e2e harness 的默认行为', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false, agendaMd: '- [ ] due:2026-05-13 check in on project' })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps) // no `health` field at all
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.dispatch).toHaveBeenCalledOnce()
  })
})

// distillAndPushOwnerKnowledge is D1's knowledge-distill block PLUS the
// optional hearth push (HI W3), extracted from ingestTick's inline D1 site
// so it can be exercised directly. ingestTick's own pipeline runs real
// plugin discovery (loadPlugins/createResilientBridge over bundledPluginsDir()),
// which in this repo's dev checkout resolves real bundled plugin symlinks —
// exercising it end-to-end here would mean spawning real MCP child
// processes, so these tests drive distillAndPushOwnerKnowledge directly
// (the exact function ingestTick calls at the D1 site) instead.
describe('distillAndPushOwnerKnowledge — hearth push (HI W3)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  // Non-empty digest source: one obligation fact, no graph — mirrors
  // knowledge-distill.test.ts's "only facts present" fixture.
  const factsKnowledge = {
    facts: { findFacts: () => ({ results: [{ predicate: '欠', value: '老王 200 元', kind: 'obligation' }] }) },
  } as unknown as TickDeps['boot']['knowledge']

  const knowledgeMdPath = (stateDir: string, chatId: string) => join(stateDir, 'memory', chatId, 'knowledge.md')

  it('hearth off (real connectHearth, default config) — knowledge.md written exactly as before D1, zero hearth calls', async () => {
    // No hearthConnect seam override here — this exercises the REAL
    // connectHearth from hearth-client.ts. loadCompanionConfig(stateDir)
    // has no hearth_* keys in the config written by setupDeps, so
    // defaultCompanionConfig()'s hearth_enabled:false applies and
    // connectHearth returns null WITHOUT spawning anything — proving
    // feature-off is a true no-op, not just a stubbed test.
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    s.deps.boot = { ...s.deps.boot, knowledge: factsKnowledge } as never
    await distillAndPushOwnerKnowledge(s.deps, 'chat-1')
    expect(readFileSync(knowledgeMdPath(s.stateDir, 'chat-1'), 'utf8')).toContain('老王 200 元')
    expect(s.logs.some(l => l.includes('distilled knowledge.md for chat-1'))).toBe(true)
    expect(s.logs.some(l => l.toLowerCase().includes('hearth'))).toBe(false)
  })

  it('fake hearth (enabled) + low-risk plan ⇒ submit then applyForOwner(_, ownerChat, "wechat")', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    s.deps.boot = { ...s.deps.boot, knowledge: factsKnowledge } as never
    const close = vi.fn(async () => {})
    const submit = vi.fn(async (_plan: unknown) => ({ change_id: 'plan-1', requires_review: false }))
    const applyForOwner = vi.fn(async () => ({ ok: true }))
    const hearthConnect = vi.fn(async () => ({ submit, applyForOwner, close }))
    s.deps.hearthConnect = hearthConnect as never

    await distillAndPushOwnerKnowledge(s.deps, 'chat-1')

    expect(hearthConnect).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledOnce()
    const plan = submit.mock.calls[0]![0] as { risk: string; requires_review: boolean }
    expect(plan.risk).toBe('low')
    expect(applyForOwner).toHaveBeenCalledWith('plan-1', 'chat-1', 'wechat')
    expect(close).toHaveBeenCalledOnce()
    expect(s.logs.some(l => l.includes('hearth: applied plan-1 (ok=true)'))).toBe(true)
  })

  it('requires_review plan is submitted but NOT applied', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    s.deps.boot = { ...s.deps.boot, knowledge: factsKnowledge } as never
    const close = vi.fn(async () => {})
    const submit = vi.fn(async () => ({ change_id: 'plan-2', requires_review: true }))
    const applyForOwner = vi.fn(async () => ({ ok: true }))
    s.deps.hearthConnect = vi.fn(async () => ({ submit, applyForOwner, close })) as never

    await distillAndPushOwnerKnowledge(s.deps, 'chat-1')

    expect(submit).toHaveBeenCalledOnce()
    expect(applyForOwner).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce() // still closed even though nothing was applied
    expect(s.logs.some(l => l.includes('plan plan-2 requires review'))).toBe(true)
  })

  it('a throwing hearth client (submit rejects) does not break the tick — knowledge.md still written, close still runs', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    s.deps.boot = { ...s.deps.boot, knowledge: factsKnowledge } as never
    const close = vi.fn(async () => {})
    const submit = vi.fn(async () => { throw new Error('boom: malformed hearth mcp result') })
    const applyForOwner = vi.fn(async () => ({ ok: true }))
    s.deps.hearthConnect = vi.fn(async () => ({ submit, applyForOwner, close })) as never

    await expect(distillAndPushOwnerKnowledge(s.deps, 'chat-1')).resolves.toBeUndefined()

    expect(readFileSync(knowledgeMdPath(s.stateDir, 'chat-1'), 'utf8')).toContain('老王 200 元')
    expect(applyForOwner).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce() // finally still ran despite the throw
    expect(s.logs.some(l => l.includes('hearth push failed'))).toBe(true)
  })

  it('a throwing connectHearth itself does not break the tick — knowledge.md still written', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    s.deps.boot = { ...s.deps.boot, knowledge: factsKnowledge } as never
    s.deps.hearthConnect = vi.fn(async () => { throw new Error('spawn ENOENT') }) as never

    await expect(distillAndPushOwnerKnowledge(s.deps, 'chat-1')).resolves.toBeUndefined()

    expect(readFileSync(knowledgeMdPath(s.stateDir, 'chat-1'), 'utf8')).toContain('老王 200 元')
    expect(s.logs.some(l => l.includes('hearth push failed'))).toBe(true)
  })

  it('empty digest — hearth still connects (per the digest-independent connect) but never submits; close still runs (no leaked client)', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    // Pre-seed a stale knowledge.md from an earlier cycle — empty digest
    // this time must remove it (unchanged D1 behavior).
    const memDir = join(s.stateDir, 'memory', 'chat-1')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'knowledge.md'), 'stale')
    const close = vi.fn(async () => {})
    const submit = vi.fn(async () => ({ change_id: 'x', requires_review: false }))
    const hearthConnect = vi.fn(async () => ({ submit, applyForOwner: vi.fn(), close }))
    s.deps.hearthConnect = hearthConnect as never
    // deps.boot.knowledge left undefined ⇒ distillOwnerKnowledge(undefined) === ''.

    await distillAndPushOwnerKnowledge(s.deps, 'chat-1')

    expect(existsSync(join(memDir, 'knowledge.md'))).toBe(false)
    expect(hearthConnect).toHaveBeenCalledOnce()
    expect(submit).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('buildTickBodies / introspectTick — provider-agnostic cheap eval (PR F)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('skips the tick when no registered provider implements cheapEval', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    // setupDeps already wires registry.getCheapEval to return null.
    const { introspectTick } = buildTickBodies(s.deps)
    await introspectTick()
    expect(s.logs.some(l => l.includes('skip tick — no registered provider implements cheapEval'))).toBe(true)
  })

  it('resolves cheapEval via registry per-tick (proves no hardcoded Claude SDK call)', async () => {
    // Spy on getCheapEval to verify introspect goes through the
    // provider-agnostic registry path. Returning null causes the tick
    // to skip immediately — we don't need a real db just to assert
    // resolver invocation.
    const getCheapEval = vi.fn(() => null)
    const s = setupDeps({ defaultChatId: 'chat-introspect', inFlight: false })
    cleanup.push(s.stateDir)
    s.deps.boot = {
      ...s.deps.boot,
      registry: { getCheapEval } as never,
    }
    const { introspectTick } = buildTickBodies(s.deps)
    await introspectTick()
    expect(getCheapEval).toHaveBeenCalledTimes(1)
  })
})

describe('buildTickBodies / introspectTick — optional Atelier mount', () => {
  it('runs an injected Atelier callback after the existing introspect work', async () => {
    const s = setupDeps({ defaultChatId: 'atelier-chat', inFlight: false })
    const order: string[] = []
    const sdkEval = vi.fn(async () => {
      order.push('introspect')
      return JSON.stringify({ write: false })
    })
    s.deps.boot = {
      ...s.deps.boot,
      registry: { getCheapEval: () => sdkEval } as never,
    } as never
    s.deps.runAtelierTick = vi.fn(async () => { order.push('atelier') })
    const { introspectTick } = buildTickBodies(s.deps)
    await introspectTick({ nowIso: '2026-09-01T12:00:00.000Z' })
    expect(s.deps.runAtelierTick).toHaveBeenCalledWith({ nowIso: '2026-09-01T12:00:00.000Z' })
    expect(order.at(-1)).toBe('atelier')
  })

  it('contains an Atelier failure and keeps the tick resolved', async () => {
    const s = setupDeps({ defaultChatId: 'atelier-chat', inFlight: false })
    const sdkEval = vi.fn(async () => JSON.stringify({ write: false }))
    s.deps.boot = { ...s.deps.boot, registry: { getCheapEval: () => sdkEval } as never } as never
    s.deps.runAtelierTick = async () => { throw new Error('no hosted brush') }
    const { introspectTick } = buildTickBodies(s.deps)
    await expect(introspectTick({ nowIso: '2026-09-01T12:00:00.000Z' })).resolves.toBeUndefined()
    expect(s.logs.some(line => line.includes('ATELIER|tick failed: no hosted brush'))).toBe(true)
  })
})

describe('buildTickBodies / introspectTick — memory gardener mount', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('cheapEval absent ⇒ gardener never runs (no GARDEN log, no archive dir created)', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    // Seed a large memory file that WOULD be eligible if the gardener ran.
    const memDir = join(s.stateDir, 'memory', 'chat-1')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'profile.md'), 'x'.repeat(3000))
    const { introspectTick } = buildTickBodies(s.deps)
    await introspectTick()
    expect(s.logs.some(l => l.startsWith('GARDEN|'))).toBe(false)
    expect(existsSync(join(s.stateDir, 'memory-archive'))).toBe(false)
  })

  it('cheapEval present ⇒ introspectTick invokes the gardener after the existing steps', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const memDir = join(s.stateDir, 'memory', 'chat-1')
    mkdirSync(memDir, { recursive: true })
    // "seed\nfiller filler ..." rather than a single repeated-char run: the
    // gardener's vocabulary-overlap validation requires a curated output to
    // actually share word tokens with the original, which a giant run of
    // one repeated character can't satisfy in the same way real prose can.
    const original = `seed\n${'filler '.repeat(500)}`
    writeFileSync(join(memDir, 'profile.md'), original)
    // Curated output must also clear the shrink floor (min(512, 0.2 *
    // originalBytes)) — a bare "seed filler" (11 bytes) would now be
    // rejected as over_shrunk before the gardener ever writes it, so keep
    // enough of the original's filler tokens to pass.
    const curated = `seed\n${'filler '.repeat(100)}`.trim()
    expect(Buffer.byteLength(curated, 'utf8')).toBeGreaterThan(0.2 * Buffer.byteLength(original, 'utf8'))
    expect(Buffer.byteLength(curated, 'utf8')).toBeLessThan(Buffer.byteLength(original, 'utf8'))
    const cheapEval = vi.fn(async () => curated)
    s.deps.boot = { ...s.deps.boot, registry: { getCheapEval: () => cheapEval } as never }
    const { introspectTick } = buildTickBodies(s.deps)
    await introspectTick({ nowIso: '2026-07-10T00:00:00.000Z' })
    expect(s.logs.some(l => l.startsWith('GARDEN|'))).toBe(true)
    expect(existsSync(join(s.stateDir, 'memory-archive', 'chat-1', 'profile.md.2026-07-10.md'))).toBe(true)
    expect(readFileSync(join(memDir, 'profile.md'), 'utf8')).toBe(curated)
  })
})

describe('人类做客 —— 朋友来聊过、走了,伙伴跟主人提一句', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => { for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }) } catch { /* */ } } })

  const seedGuest = async (s: Setup, chatId: string, base: string, n = 2) => {
    const ms = makeMessagesStore(s.db)
    for (let i = 0; i < n; i++) {
      await ms.append({ id: `${chatId}:${i}`, chatId, ts: new Date(Date.parse(base) + i * 60_000).toISOString(), direction: 'in', kind: 'text', text: `客人第${i + 1}句`, source: 'live' })
      await ms.append({ id: `${chatId}:o${i}`, chatId, ts: new Date(Date.parse(base) + i * 60_000 + 1000).toISOString(), direction: 'out', kind: 'text', text: '好的', source: 'live' })
    }
  }
  const armEval = (s: Setup, out = '刚才小王来过,问了工具的事。') => {
    const evalFn = vi.fn(async (_p: string) => out)
    ;(s.deps.boot as unknown as { registry: unknown }).registry = { getCheapEval: () => evalFn, getStrongEval: () => null }
    ;(s.deps.boot as unknown as { conversationStore: unknown }).conversationStore = { getIdentity: () => ({ last_user_name: '小王' }) }
    const sent: string[] = []
    ;(s.deps.ilink as unknown as { sendMessage: unknown }).sendMessage = async (_c: string, t: string) => { sent.push(t); return { msgId: '1' } }
    return { evalFn, sent }
  }
  // 打猎/串门那些分支要在这些测试里安静:打猎冷却中、无社交接线
  const quiet = (chatId: string) => ({ careLedgerEntries: { [chatId]: { lastHuntAtIso: '2026-05-13T09:00:00.000Z', noReplyCount: 0 } } })

  it('客人 40 分钟前聊了两句,走了 → 讲给主人,进背包(标题「小王来过」),记水位', async () => {
    const s = setupDeps({ defaultChatId: 'owner', inFlight: false, ...quiet('owner') })
    cleanup.push(s.stateDir)
    await seedGuest(s, 'guest@im.wechat', '2026-05-13T09:15:00.000Z')
    const { evalFn, sent } = armEval(s)
    const recorded: Array<{ peerLabel: string }> = []
    const ticks = buildTickBodies({ ...s.deps, huntStore: { recordHunt: () => 0, recordVisit: (a) => { recorded.push(a); return 'r' } } })
    await ticks.pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(evalFn).toHaveBeenCalledOnce()
    expect(evalFn.mock.calls[0]![0]).toContain('小王')
    expect(evalFn.mock.calls[0]![0]).toContain('别复述原话')
    expect(sent).toEqual(['🛎 刚才小王来过,问了工具的事。'])
    expect(recorded[0]!.peerLabel).toBe('小王来过')
    // 再跑一拍:水位挡住,不重复讲
    await ticks.pushTick({ nowIso: '2026-05-13T10:05:00.000Z' })
    expect(evalFn).toHaveBeenCalledOnce()
  })

  it('**客人还在聊(最后一句 5 分钟前)→ 不讲**', async () => {
    const s = setupDeps({ defaultChatId: 'owner', inFlight: false, ...quiet('owner') })
    cleanup.push(s.stateDir)
    await seedGuest(s, 'guest@im.wechat', '2026-05-13T09:54:00.000Z')
    const { evalFn } = armEval(s)
    await buildTickBodies(s.deps).pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(evalFn).not.toHaveBeenCalled()
  })

  it('**主人自己(admin)的对话不算做客**', async () => {
    const s = setupDeps({ defaultChatId: 'owner', inFlight: false, ...quiet('owner') })
    cleanup.push(s.stateDir)
    await seedGuest(s, 'owner', '2026-05-13T09:00:00.000Z')
    const { evalFn } = armEval(s)
    await buildTickBodies(s.deps).pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(evalFn).not.toHaveBeenCalled()
  })

  it('只说了一句「在吗」→ 不算做客', async () => {
    const s = setupDeps({ defaultChatId: 'owner', inFlight: false, ...quiet('owner') })
    cleanup.push(s.stateDir)
    await seedGuest(s, 'guest@im.wechat', '2026-05-13T09:00:00.000Z', 1)
    const { evalFn } = armEval(s)
    await buildTickBodies(s.deps).pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(evalFn).not.toHaveBeenCalled()
  })
})

describe('日程判断(spec 2026-09-05-companion-plan)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => { for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }) } catch { /* */ } } })
  const NOW = '2026-05-13T10:00:00.000Z'
  const planEvalOf = (raw: string | Error) => vi.fn(async (_prompt: string) => { if (raw instanceof Error) throw raw; return raw })

  it('候选 [hunt, visit],模型选 visit → 只出门不打猎;prompt 含两个候选', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: true })
    const planEval = planEvalOf('{"action":"visit","why":"上午没人聊"}')
    await buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
    expect(planEval).toHaveBeenCalledOnce()
    expect(planEval.mock.calls[0]![0]).toContain('"hunt"')
    expect(planEval.mock.calls[0]![0]).toContain('"visit"')
    expect(startVisit).toHaveBeenCalledOnce()
    expect(s.dispatch).not.toHaveBeenCalled()                       // 没打猎
    expect(s.careLedgerEntries['chat-1']?.lastVisitAtIso).toBe(NOW)
    expect(s.careLedgerEntries['chat-1']?.lastHuntAtIso).toBeUndefined()
    expect(s.logs.some(l => l.startsWith('PLAN|') && l.includes('→ visit'))).toBe(true)
  })

  it('模型选 none → 什么都不发,plan-log 多一条;10 分钟后再跑一拍不再问(退避)', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    withVisit(s, { hasOpen: true })
    const planEval = planEvalOf('{"action":"none","why":"主人在聊"}')
    const ticks = buildTickBodies({ ...s.deps, planEval })
    await ticks.pushTick({ nowIso: NOW })
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(readPlanLog(s.stateDir, formatLocal(NOW).slice(0, 10))).toHaveLength(1)
    await ticks.pushTick({ nowIso: '2026-05-13T10:10:00.000Z' })
    expect(planEval).toHaveBeenCalledOnce()                         // 第二拍没问
    expect(s.logs.some(l => l.includes('reason=backoff'))).toBe(true)
  })

  it('模型选了候选外的 gap → 降级为 none,日志含 downgraded,不发', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const planEval = planEvalOf('{"action":"gap","why":"想问候"}')
    await buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('downgraded'))).toBe(true)
  })

  it('降级(答了候选外的动作)也退避 —— 10 分钟后再跑一拍不再问', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const planEval = planEvalOf('{"action":"gap","why":"想问候"}')   // gap 不在候选里(never_talked)→ 降级
    const ticks = buildTickBodies({ ...s.deps, planEval })
    await ticks.pushTick({ nowIso: NOW })
    expect(s.dispatch).not.toHaveBeenCalled()
    await ticks.pushTick({ nowIso: '2026-05-13T10:10:00.000Z' })
    expect(planEval).toHaveBeenCalledOnce()                         // 第二拍没问
    expect(s.logs.some(l => l.includes('reason=backoff'))).toBe(true)
  })

  it('模型抛错 / 回非 JSON → 回退旧顺序:先打猎', async () => {
    for (const bad of [new Error('boom'), 'not json']) {
      const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
      cleanup.push(s.stateDir)
      const startVisit = withVisit(s, { hasOpen: true })
      await buildTickBodies({ ...s.deps, planEval: planEvalOf(bad) }).pushTick({ nowIso: NOW })
      expect(s.dispatch).toHaveBeenCalledOnce()                     // 打猎
      expect(startVisit).not.toHaveBeenCalled()
      expect(s.logs.some(l => l.includes('PLAN|fallback'))).toBe(true)
    }
  })

  it('模型超时 → 回退旧顺序', async () => {
    vi.useFakeTimers()
    try {
      const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
      cleanup.push(s.stateDir)
      const planEval = vi.fn(() => new Promise<string>(() => { /* never */ }))
      const p = buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
      await vi.advanceTimersByTimeAsync(PLAN_EVAL_TIMEOUT_MS + 1)
      await p
      expect(s.dispatch).toHaveBeenCalledOnce()
      expect(s.logs.some(l => l.includes('reason=timeout'))).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('没有 planEval 且 registry 没有 cheapEval → 旧行为,不写 plan-log', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    await buildTickBodies(s.deps).pushTick({ nowIso: NOW })
    expect(s.dispatch).toHaveBeenCalledOnce()                       // 打猎(旧顺序第一)
    expect(s.logs.some(l => l.includes('reason=no_evaluator'))).toBe(true)
  })

  it('没有 evaluator 的 fallback 也照样写 plan-log,source=fallback', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    await buildTickBodies(s.deps).pushTick({ nowIso: NOW })
    const log = readPlanLog(s.stateDir, formatLocal(NOW).slice(0, 10))
    expect(log).toHaveLength(1)
    expect(log[0]!.source).toBe('fallback')
    expect(log[0]!.decision).toBe('hunt')
  })

  it('会话在忙(pre-gate,候选 [hunt])→ 一个模型都不问,PLAN skip reason=session_in_flight', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: true })
    cleanup.push(s.stateDir)
    const planEval = planEvalOf('{"action":"hunt","why":"x"}')
    await buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
    expect(planEval).not.toHaveBeenCalled()
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.startsWith('PLAN|skip') && l.includes('session_in_flight'))).toBe(true)
  })

  it('agenda 到期 → 直接发 agenda,planEval 从未被调', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false, agendaMd: '- [ ] due:2026-05-13 问问搬家' })
    cleanup.push(s.stateDir)
    const planEval = planEvalOf('{"action":"none","why":"x"}')
    await buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
    expect(planEval).not.toHaveBeenCalled()
    expect(s.dispatch).toHaveBeenCalledOnce()
  })

  it('候选为空(打猎与串门都在冷却、安静不够久)→ planEval 从未被调', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1', inFlight: false,
      careLedgerEntries: { 'chat-1': { lastHuntAtIso: '2026-05-13T09:00:00.000Z', lastVisitAtIso: '2026-05-13T09:30:00.000Z', lastProactiveAtIso: '2026-05-13T09:00:00.000Z', noReplyCount: 0 } },
    })
    cleanup.push(s.stateDir)
    withVisit(s, { hasOpen: true })
    const planEval = planEvalOf('{"action":"hunt","why":"x"}')
    await buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
    expect(planEval).not.toHaveBeenCalled()
    expect(s.dispatch).not.toHaveBeenCalled()
  })

  it('visit 带候选 id 的 target → startVisit(target);不在候选里 → startVisit()', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: true })
    ;(s.deps.boot as unknown as { social: { penpal: Record<string, unknown> } }).social.penpal.provenChannels = () => [{ id: 'ch', label: '第 1 度的朋友' }]
    await buildTickBodies({ ...s.deps, planEval: planEvalOf('{"action":"visit","why":"w","target":"ch"}') }).pushTick({ nowIso: NOW })
    expect(startVisit).toHaveBeenCalledWith('ch')
    const s2 = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s2.stateDir)
    const startVisit2 = withVisit(s2, { hasOpen: true })
    ;(s2.deps.boot as unknown as { social: { penpal: Record<string, unknown> } }).social.penpal.provenChannels = () => [{ id: 'ch', label: '第 1 度的朋友' }]
    await buildTickBodies({ ...s2.deps, planEval: planEvalOf('{"action":"visit","why":"w","target":"zzz"}') }).pushTick({ nowIso: NOW })
    expect(startVisit2).toHaveBeenCalledWith()
  })

  it('问成功之后不留定时器 —— 20 秒的超时闹钟当场撤掉', async () => {
    vi.useFakeTimers()
    try {
      const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
      cleanup.push(s.stateDir)
      withVisit(s, { hasOpen: true })
      await buildTickBodies({ ...s.deps, planEval: planEvalOf('{"action":"none","why":"x"}') }).pushTick({ nowIso: NOW })
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('微信断了、候选里没有串门 → 一个模型都不问(不烧 token,也不重试)', async () => {
    const db = openTestDb()
    const ms = makeMessagesStore(db)
    // 12 天前说过话 ⇒ gap 也是候选,于是候选是 [hunt, gap],两件都要走微信。
    await ms.append({ id: 'm1', chatId: 'chat-1', ts: '2026-05-01T10:00:00.000Z', direction: 'in', kind: 'text', text: 'hi', source: 'live' })
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false, db })
    cleanup.push(s.stateDir)
    const planEval = planEvalOf('{"action":"hunt","why":"x"}')
    await buildTickBodies({ ...s.deps, planEval, health: { shouldSuspend: () => true } }).pushTick({ nowIso: NOW })
    expect(planEval).not.toHaveBeenCalled()
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.startsWith('PLAN|skip') && l.includes('wechat_degraded'))).toBe(true)
  })

  it('微信断了但能串门 → 候选只剩串门,照样问,照样出门(串门不是一条微信)', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: true })
    const planEval = planEvalOf('{"action":"visit","why":"链路断着也能出门"}')
    await buildTickBodies({ ...s.deps, planEval, health: { shouldSuspend: () => true } }).pushTick({ nowIso: NOW })
    expect(planEval).toHaveBeenCalledOnce()
    expect(planEval.mock.calls[0]![0]).toContain('["visit"]')       // 【候选】只剩它
    expect(planEval.mock.calls[0]![0]).not.toContain('"hunt","visit"')
    expect(startVisit).toHaveBeenCalledOnce()
    expect(s.dispatch).not.toHaveBeenCalled()
  })

  it('provenChannels 抛了也掀不翻这一拍', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: true })
    ;(s.deps.boot as unknown as { social: { penpal: Record<string, unknown> } }).social.penpal.provenChannels = () => { throw new Error('boom') }
    await buildTickBodies({ ...s.deps, planEval: planEvalOf('{"action":"visit","why":"w"}') }).pushTick({ nowIso: NOW })
    expect(startVisit).toHaveBeenCalledOnce()
    expect(s.logs.some(l => l.startsWith('PLAN|') && l.includes('→ visit'))).toBe(true)
  })

  it('预判过闸之后、真发之前会话忙起来了(送时被跳过)→ 台账记 (skipped),不记成做过了', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    s.isInFlight.mockReturnValueOnce(false).mockReturnValueOnce(true) // 预判闸放行,送时闸挡住
    const planEval = planEvalOf('{"action":"hunt","why":"x"}')
    await buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
    expect(s.dispatch).not.toHaveBeenCalled()
    const log = readPlanLog(s.stateDir, formatLocal(NOW).slice(0, 10))
    expect(log).toHaveLength(1)
    expect(log[0]!.decision).toBe('hunt')
    expect(log[0]!.why).toBe('(skipped) x')
  })

  it('做砸了台账记 (failed),不记成做过了', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const startVisit = vi.fn(async () => { throw new Error('boom') })
    ;(s.deps.boot as unknown as { social: unknown }).social = {
      penpal: { startVisit, channelStore: { list: () => [{ id: 'ch', status: 'open' }] } },
    }
    await buildTickBodies({ ...s.deps, planEval: planEvalOf('{"action":"visit","why":"出门"}') }).pushTick({ nowIso: NOW })
    const log = readPlanLog(s.stateDir, formatLocal(NOW).slice(0, 10))
    expect(log).toHaveLength(1)
    expect(log[0]!.why).toBe('(failed) 出门')
    expect(s.logs.some(l => l.includes('companion tick failed'))).toBe(true)
  })
})
