export type PermissionDecision = 'allow' | 'deny' | 'timeout' | 'undelivered'

/** Desktop-facing description of a pending permission ask (CC 桌宠 Phase B). */
export interface PendingPermissionMeta { chatId: string; prompt: string }

/** Row shape returned by PendingPermissions.list(). */
export interface PendingPermissionView { hash: string; chatId: string; prompt: string; since: string; expires_at: string }

interface Entry {
  resolve: (d: PermissionDecision) => void
  expiresAt: number
  registeredAt: number
  meta: PendingPermissionMeta | null
}

export class PendingPermissions {
  private readonly entries = new Map<string, Entry>()

  register(hash: string, timeoutMs: number, meta?: PendingPermissionMeta): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.entries.set(hash, {
        resolve,
        expiresAt: Date.now() + timeoutMs,
        registeredAt: Date.now(),
        meta: meta ?? null,
      })
    })
  }

  /**
   * Snapshot of all pending asks, for the desktop pet to display the same
   * approval queue that WeChat sees. Sorted by since ascending (oldest
   * first). Entries registered before this Phase B meta param existed carry
   * no meta — chatId/prompt read as '' rather than throwing.
   */
  list(): PendingPermissionView[] {
    return Array.from(this.entries.entries())
      .map(([hash, e]) => ({ hash, chatId: e.meta?.chatId ?? '', prompt: e.meta?.prompt ?? '', since: new Date(e.registeredAt).toISOString(), expires_at: new Date(e.expiresAt).toISOString() }))
      .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))
  }

  consume(hash: string, decision: 'allow' | 'deny'): boolean {
    const entry = this.entries.get(hash)
    if (!entry) return false
    this.entries.delete(hash)
    entry.resolve(decision)
    return true
  }

  /**
   * Resolve a pending request as 'undelivered' — the approval prompt could
   * not be sent to the approver (e.g. their proactive-push window is closed),
   * so no reply can ever come. Fail fast instead of dead-waiting the full
   * timeout (which would hang the whole turn until it gets timeout-killed).
   */
  fail(hash: string): boolean {
    const entry = this.entries.get(hash)
    if (!entry) return false
    this.entries.delete(hash)
    entry.resolve('undelivered')
    return true
  }

  sweep(): void {
    const now = Date.now()
    for (const [hash, entry] of Array.from(this.entries.entries())) {
      if (entry.expiresAt <= now) {
        this.entries.delete(hash)
        entry.resolve('timeout')
      }
    }
  }

  size(): number {
    return this.entries.size
  }
}

// Matches "y abc12" or "n abc12" (5-char hash, case-insensitive y/n).
const PERMISSION_REPLY_RE = /^([yn])\s+([A-Za-z0-9]{5})$/i

export function parsePermissionReply(text: string): { decision: 'allow' | 'deny'; hash: string } | null {
  const m = PERMISSION_REPLY_RE.exec(text.trim())
  if (!m) return null
  return {
    decision: m[1]!.toLowerCase() === 'y' ? 'allow' : 'deny',
    hash: m[2]!,
  }
}
