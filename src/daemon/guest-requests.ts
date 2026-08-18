/**
 * guest-requests.ts — pending guest request store + invite-code machinery
 * (spec docs/superpowers/specs/2026-08-18-guest-path-design.md §1).
 *
 * Durable (state-store write-through, debounceMs:0 — repo convention, see
 * onboarding.ts / incident-store.ts) so an owner who approves three hours
 * later still finds the request. Fixes the "restart amnesia" both prior
 * short-code templates (配对码, 权限中继 y/n hash) shared.
 *
 * notifiedAt is stamped INSIDE upsertRequest, in the same synchronous
 * write-through call that creates the request — not by a separate setter
 * after the notify message is actually sent (the store's public surface
 * has none). That's a deliberate trade-off: "single-notify" durability
 * beats guaranteed delivery here (spec §0 decision 1) — a crash between
 * the store write and the actual `notifyOwner` call loses that one
 * notification (recoverable via the owner's "待批准" command) rather than
 * risking a re-notify storm on every retried inbound.
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
  notifiedAt: number | null       // 单人单通知的 durable 标记
  status: GuestRequestStatus
}

export interface InviteCode {
  code: string
  createdAt: number
}

export interface GuestRequestStore {
  // 请求:每 chatId 至多一条活跃;重复入站返回既有条目(不重建、不重通知)
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
  /** Records message `id` as seen and reports whether it was ALREADY seen
   *  before this call (spec §2 step 1: at-least-once redelivery guard for
   *  the guest branch, which sits upstream of mw-dedup). Persisted in the
   *  same file so a restart mid-storm doesn't replay the guest branch. */
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

  function readSeen(): string[] {
    const raw = store.get(SEEN_KEY)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed as string[] : []
    } catch {
      return []
    }
  }

  function writeSeen(ids: string[]): void {
    store.set(SEEN_KEY, JSON.stringify(ids))
  }

  function isLive(createdAt: number): boolean {
    return now() - createdAt < GUEST_REQUEST_TTL_MS
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
        notifiedAt: createdAt,
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

    seenMessage(id) {
      const seen = readSeen()
      if (seen.includes(id)) return true
      writeSeen([...seen, id])
      return false
    },
  }
}
