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

  /**
   * 谁有权拍这一条(= 当初被问的那个 chat)。返回 null 表示「没有 meta」——
   * 要么 hash 不存在,要么是 Phase B 之前注册的老条目;两种情况调用方都按
   * 旧行为处理(见 ilink-glue 的 handlePermissionReply)。
   *
   * 存在的理由:hash 现在经 GET /v1/companion/pet 对所有 trusted 调用方可见,
   * 而微信侧的「y <hash>」以前不看是谁发的 —— 任何一个 trusted 联系人读到
   * hash 就能替主人批准一条命令。ilink 不该伸手进 Entry 里掏 meta,所以在
   * 这里开一个最窄的口子。
   */
  approverOf(hash: string): string | null {
    return this.entries.get(hash)?.meta?.chatId ?? null
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
