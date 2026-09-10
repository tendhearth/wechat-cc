export type PermissionDecision = 'allow' | 'deny' | 'timeout' | 'undelivered'

/** Desktop-facing description of a pending permission ask (CC 桌宠 Phase B). */
export interface PendingPermissionMeta { chatId: string; prompt: string }

/** Row shape returned by PendingPermissions.list(). */
/** `code` 是主人在微信里回的两位数(01–99,滚动分配);`hash` 是调用方的原 id,桌面卡片与 hook 轮询仍用它。 */
export interface PendingPermissionView { hash: string; code: string; chatId: string; prompt: string; since: string; expires_at: string }

interface Entry {
  resolve: (d: PermissionDecision) => void
  expiresAt: number
  registeredAt: number
  meta: PendingPermissionMeta | null
  code: string
}

export class PendingPermissions {
  private readonly entries = new Map<string, Entry>()
  // 两位数码滚动分配:01 → 99 → 01。不是「最小未用」—— 那样刚过期的 01 马上被下一条复用,
  // 主人对着旧卡片回「y 01」就批错了。滚动 99 条才回头,手机上也只用数字键盘。
  private nextCode = 1

  register(hash: string, timeoutMs: number, meta?: PendingPermissionMeta): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.entries.set(hash, {
        resolve,
        expiresAt: Date.now() + timeoutMs,
        registeredAt: Date.now(),
        meta: meta ?? null,
        code: this.allocateCode(),
      })
    })
  }

  private allocateCode(): string {
    const inUse = new Set(Array.from(this.entries.values()).map(e => e.code))
    for (let i = 0; i < 99; i++) {
      const n = ((this.nextCode - 1 + i) % 99) + 1
      const code = String(n).padStart(2, '0')
      if (!inUse.has(code)) { this.nextCode = (n % 99) + 1; return code }
    }
    // 99 条同时待批不可能发生;真发生了就退回原 hash,起码不撞。
    return ''
  }

  /** 主人回的两位数码 → hash;不存在返回 null。 */
  hashOfCode(code: string): string | null {
    for (const [hash, e] of this.entries) if (e.code === code) return hash
    return null
  }

  /** 这条的两位数码(给卡片文案用)。 */
  codeOf(hash: string): string | null {
    return this.entries.get(hash)?.code ?? null
  }

  /**
   * Snapshot of all pending asks, for the desktop pet to display the same
   * approval queue that WeChat sees. Sorted by since ascending (oldest
   * first). Entries registered before this Phase B meta param existed carry
   * no meta — chatId/prompt read as '' rather than throwing.
   */
  list(): PendingPermissionView[] {
    return Array.from(this.entries.entries())
      .map(([hash, e]) => ({ hash, code: e.code, chatId: e.meta?.chatId ?? '', prompt: e.meta?.prompt ?? '', since: new Date(e.registeredAt).toISOString(), expires_at: new Date(e.expiresAt).toISOString() }))
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

/**
 * 主人在微信里的拍板:
 *   「y」「n」                     —— 只有一条待批时不用带码(最常见)
 *   「y 07」「y07」「Y 07」        —— 两位数码,手机数字键盘就能打
 *   「y k3x9z」                    —— 旧的 5 位 hash 仍认(桌面卡片、老截图)
 *   「同意 / 允许 / 放行」「拒绝 / 不允许 / 不行」—— 中文等价词
 * 故意**不**认「好」「不」这种日常用语:待批窗口里主人正常聊天说一句「好」就把命令放行了,不行。
 * 返回的 ref 为 null 表示没带码,由调用方按「当前待批几条」决定。
 */
const ALLOW_WORDS = ['y', 'yes', '同意', '允许', '放行']
const DENY_WORDS = ['n', 'no', '拒绝', '不允许', '不行']
const PERMISSION_REPLY_RE = new RegExp(`^(${[...ALLOW_WORDS, ...DENY_WORDS].join('|')})\\s*([0-9]{1,2}|[A-Za-z0-9]{5})?$`, 'i')

export type PermissionReplyRef = { kind: 'code'; value: string } | { kind: 'hash'; value: string }

export function parsePermissionReply(text: string): { decision: 'allow' | 'deny'; ref: PermissionReplyRef | null } | null {
  const m = PERMISSION_REPLY_RE.exec(text.trim())
  if (!m) return null
  const word = m[1]!.toLowerCase()
  const decision = ALLOW_WORDS.includes(word) ? 'allow' : 'deny'
  const raw = m[2]
  if (!raw) return { decision, ref: null }
  if (/^[0-9]{1,2}$/.test(raw)) return { decision, ref: { kind: 'code', value: raw.padStart(2, '0') } }
  return { decision, ref: { kind: 'hash', value: raw } }
}
