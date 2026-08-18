/**
 * guest-requests.ts — pending guest request store + invite-code machinery
 * (spec docs/superpowers/specs/2026-08-18-guest-path-design.md §1).
 *
 * Durable (state-store write-through, debounceMs:0 — repo convention, see
 * onboarding.ts / incident-store.ts) so an owner who approves three hours
 * later still finds the request. Fixes the "restart amnesia" both prior
 * short-code templates (配对码, 权限中继 y/n hash) shared.
 *
 * notifiedAt starts `null` at creation and is flipped to `now()` only by
 * `markNotified()`, called AFTER the owner notification actually sends
 * successfully — same shape as incident-store's markNotified-after-
 * safeNotify (health/incident-store.ts:74-79 + health/index.ts:80-84).
 * `ilink.sendMessage` resolving `{ error }` is a live failure mode in this
 * repo; stamping notifiedAt eagerly at creation would let a failed send
 * durably mark the guest "notified" with the owner never actually told —
 * stuck on "稍等哦~" for up to 48h. See `GuestRequestStore.upsertRequest`'s
 * doc comment for the retry contract this leaves for mw-access (T4).
 *
 * Two independent 6-digit code namespaces share the same generator
 * (genCode, node:crypto randomInt — pairing's convention, see
 * wire-pairing.ts:57) but each checks collisions against its OWN pool
 * only: a request code and an invite code may legitimately coincide.
 */
import { randomInt } from 'node:crypto'
import { join } from 'node:path'
import type { InboundMsg } from '../core/prompt-format'
import { makeStateStore, type StateStore } from './state-store'

export type GuestRequestStatus = 'pending' | 'denied'

export interface GuestRequest {
  chatId: string                 // = userId(ilink 1:1)
  firstMsg: InboundMsg            // 批准后 redispatch 用(onboarding 同款持久化先例)
  contextToken: string            // 定向 hydrate ctxStore 用
  accountId: string               // 账号路由
  code: string                    // 6 位数字(配对码同款 randomInt padStart)
  createdAt: number
  /** null 直到 markNotified() 在 owner 通知实际发送成功后调用 — 单人
   *  单通知的 durable 标记,但只在"确实发出去了"之后才落定。见
   *  GuestRequestStore.upsertRequest 的重试契约。 */
  notifiedAt: number | null
  status: GuestRequestStatus
}

export interface InviteCode {
  code: string
  createdAt: number
}

export interface GuestRequestStore {
  /**
   * 请求:每 chatId 至多一条活跃;重复入站返回既有条目(不重建)。
   *
   * RETRY CONTRACT for callers (mw-access / T4): a fresh `GuestRequest`'s
   * `notifiedAt` starts `null` — it is NOT stamped by this call. The
   * caller must attempt the owner notification whenever EITHER
   * `fresh === true` (brand-new request) OR the returned
   * `request.notifiedAt === null` (an EXISTING request — `fresh` reads
   * `false` for it — whose prior notify attempt crashed or the send
   * itself failed, e.g. `ilink.sendMessage` resolving `{ error }`).
   * Either way, call `markNotified(chatId)` immediately after a
   * successful send. This makes "notify" retry on every guest message
   * until it actually lands once, rather than silently marking a failed
   * send as delivered.
   */
  upsertRequest(input: {
    chatId: string
    firstMsg: InboundMsg
    contextToken: string
    accountId: string
  }): { request: GuestRequest; fresh: boolean }
  findByCode(code: string): GuestRequest | null
  resolve(code: string, outcome: 'allowed' | 'denied'): GuestRequest | null
  listPending(): GuestRequest[]
  // 邀请码:可多枚并存;consume 为单次使用原子删除
  createInvite(): InviteCode
  consumeInvite(code: string): boolean
  wasDenied(chatId: string): boolean
  /** Flips `notifiedAt` from `null` to `now()` on an existing PENDING
   *  record — call this AFTER the owner notification actually sends
   *  (repo precedent: incident-store's markNotified-after-safeNotify,
   *  see health/incident-store.ts:74-79 + health/index.ts:80-84). No-op
   *  — safe to call redundantly — when the record is absent, not
   *  pending (e.g. already denied), or already notified. */
  markNotified(chatId: string): void
  /** Records message `id` as seen and reports whether it was ALREADY seen
   *  before this call (spec §2 step 1: at-least-once redelivery guard for
   *  the guest branch, which sits upstream of mw-dedup). Persisted in the
   *  same file so a restart mid-storm doesn't replay the guest branch.
   *  Same 48h TTL as requests/invites — lazily pruned, not a permanent
   *  ledger. */
  seenMessage(id: string): boolean
}

export interface GuestRequestStoreDeps {
  stateDir: string
  now?: () => number
  /** Test seam — inject a pre-built StateStore instead of constructing one
   *  from `stateDir` (onboarding.ts / incident-store.ts convention). */
  store?: StateStore
}

/** 48h — spec §1: both pending requests and invite codes live this long;
 *  denied records also keep this TTL before falling back to plain silence. */
export const GUEST_REQUEST_TTL_MS = 48 * 60 * 60_000

const REQUESTS_KEY = 'requests'
const INVITES_KEY = 'invites'
const SEEN_KEY = 'seen'

function genCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Regenerate on collision within `taken` (its own namespace only — spec
 *  §1: request codes and invite codes are independent pools, so this is
 *  only ever called against ONE of them at a time). Bounded retry: 1M
 *  codes vs. a handful of concurrently-live entries makes true exhaustion
 *  practically impossible — the cap only guards a broken caller from
 *  spinning forever. */
function genUniqueCode(taken: Set<string>): string {
  for (let i = 0; i < 1000; i++) {
    const code = genCode()
    if (!taken.has(code)) return code
  }
  throw new Error('guest-requests: could not allocate a unique code (namespace exhausted?)')
}

export function makeGuestRequestStore(deps: GuestRequestStoreDeps): GuestRequestStore {
  const store = deps.store ?? makeStateStore(join(deps.stateDir, 'guest-requests.json'), { debounceMs: 0 })
  const now = deps.now ?? (() => Date.now())

  function readRequests(): Record<string, GuestRequest> {
    const raw = store.get(REQUESTS_KEY)
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, GuestRequest>
        : {}
    } catch {
      return {}   // corrupt JSON — start empty, same posture as state-store itself
    }
  }

  function writeRequests(all: Record<string, GuestRequest>): void {
    store.set(REQUESTS_KEY, JSON.stringify(all))
  }

  function readInvites(): InviteCode[] {
    const raw = store.get(INVITES_KEY)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed as InviteCode[] : []
    } catch {
      return []
    }
  }

  function writeInvites(list: InviteCode[]): void {
    store.set(INVITES_KEY, JSON.stringify(list))
  }

  // id -> first-seen timestamp, so the set can be lazily pruned by the same
  // 48h TTL instead of growing unbounded (spec doesn't mandate a TTL here,
  // but the request/invite it dedupes against is itself only 48h-live, so
  // there's no reason to remember an id past that).
  function readSeen(): Record<string, number> {
    const raw = store.get(SEEN_KEY)
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, number>
        : {}
    } catch {
      return {}
    }
  }

  function writeSeen(all: Record<string, number>): void {
    store.set(SEEN_KEY, JSON.stringify(all))
  }

  function isLive(createdAt: number): boolean {
    return now() - createdAt < GUEST_REQUEST_TTL_MS
  }

  function pruneSeen(all: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [id, at] of Object.entries(all)) {
      if (isLive(at)) out[id] = at
    }
    return out
  }

  /** Read + drop expired entries. Every mutating method below writes this
   *  pruned set back regardless of whether it also changes anything else
   *  — that's the "写时懒清理" (write-time lazy cleanup) spec §1 calls for. */
  function pruneRequests(all: Record<string, GuestRequest>): Record<string, GuestRequest> {
    const out: Record<string, GuestRequest> = {}
    for (const [chatId, req] of Object.entries(all)) {
      if (isLive(req.createdAt)) out[chatId] = req
    }
    return out
  }

  function pruneInvites(list: InviteCode[]): InviteCode[] {
    return list.filter(inv => isLive(inv.createdAt))
  }

  return {
    upsertRequest(input) {
      const live = pruneRequests(readRequests())
      const existing = live[input.chatId]
      if (existing) {
        writeRequests(live)
        return { request: existing, fresh: false }
      }
      const taken = new Set(Object.values(live).map(r => r.code))
      const createdAt = now()
      const request: GuestRequest = {
        chatId: input.chatId,
        firstMsg: input.firstMsg,
        contextToken: input.contextToken,
        accountId: input.accountId,
        code: genUniqueCode(taken),
        createdAt,
        notifiedAt: null,   // set by markNotified() AFTER the send actually succeeds
        status: 'pending',
      }
      live[input.chatId] = request
      writeRequests(live)
      return { request, fresh: true }
    },

    findByCode(code) {
      const live = pruneRequests(readRequests())
      return Object.values(live).find(r => r.code === code) ?? null
    },

    resolve(code, outcome) {
      const live = pruneRequests(readRequests())
      const entry = Object.values(live).find(r => r.code === code && r.status === 'pending')
      if (!entry) {
        writeRequests(live)
        return null
      }
      if (outcome === 'allowed') {
        delete live[entry.chatId]
      } else {
        live[entry.chatId] = { ...entry, status: 'denied' }
      }
      writeRequests(live)
      return entry
    },

    listPending() {
      const live = pruneRequests(readRequests())
      return Object.values(live)
        .filter(r => r.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)
    },

    createInvite() {
      const live = pruneInvites(readInvites())
      const taken = new Set(live.map(i => i.code))
      const invite: InviteCode = { code: genUniqueCode(taken), createdAt: now() }
      writeInvites([...live, invite])
      return invite
    },

    consumeInvite(code) {
      const live = pruneInvites(readInvites())
      const idx = live.findIndex(i => i.code === code)
      if (idx === -1) {
        writeInvites(live)
        return false
      }
      live.splice(idx, 1)
      writeInvites(live)
      return true
    },

    wasDenied(chatId) {
      const live = pruneRequests(readRequests())
      return live[chatId]?.status === 'denied'
    },

    markNotified(chatId) {
      const live = pruneRequests(readRequests())
      const entry = live[chatId]
      if (!entry || entry.status !== 'pending' || entry.notifiedAt !== null) {
        writeRequests(live)   // still commit the prune even on the no-op path
        return
      }
      live[chatId] = { ...entry, notifiedAt: now() }
      writeRequests(live)
    },

    seenMessage(id) {
      const live = pruneSeen(readSeen())
      if (id in live) {
        writeSeen(live)
        return true
      }
      live[id] = now()
      writeSeen(live)
      return false
    },
  }
}
