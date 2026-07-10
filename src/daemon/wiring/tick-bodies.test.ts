import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTickBodies, buildPushTickText, buildGapCheckinText, buildHuntText, type TickDeps } from './tick-bodies'
import { TIER_PROFILES } from '../../core/user-tier'
import type { Access } from '../../lib/access'
import { openTestDb, type Db } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import type { CareLedgerEntry } from '../companion/calibration'
import type { CareLedger } from '../companion/care-ledger'

/** Minimal in-memory fake of the structural chatPrefs subset TickDeps needs. */
function makeFakeChatPrefs(
  entries: Record<string, { care?: 'off' | 'low' | 'high'; hunt?: boolean }> = {},
): { get(chatId: string): { care?: 'off' | 'low' | 'high'; hunt?: boolean }; list(): string[] } {
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
  chatPrefsEntries: Record<string, { care?: 'off' | 'low' | 'high'; hunt?: boolean }>
  careLedgerEntries: Record<string, CareLedgerEntry>
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
  chatPrefsEntries?: Record<string, { care?: 'off' | 'low' | 'high'; hunt?: boolean }>
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
      coordinator: { getMode } as never,
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
  return { stateDir, acquire, isInFlight, dispatch, logs, deps, db, chatPrefsEntries, careLedgerEntries }
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
