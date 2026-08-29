/**
 * portrait-artist.ts — CC 画的你,慢慢长 (2026-08-27).
 *
 * generatePortrait 原本只手动触发(记忆页「更新画像」),小像因此静态,
 * 不随 CC 对主人的理解加深而演化。这一步把它接进 introspect tick,像
 * 表情自画一样有节制地自动刷新:只在「档案比上次画像新(CC 学到了新
 * 东西)且距上次 ≥ 最短间隔」时重画。刻意静默 —— 小像是安静深化、翻看
 * 时发现的personal奖励,不做推送噪音(和表情那种「新礼物」通知不同)。
 *
 * 门控是纯函数(shouldRepaintPortrait);runPortraitArtist 把 IO(读时间戳
 * /生成)注入,每个失败路径非致命。
 */

/** 两次自动重画之间的最短间隔 —— 小像慢慢长,不因档案的每处小改就抖动。 */
export const PORTRAIT_MIN_INTERVAL_MS = 4 * 86_400_000  // 4 天

/**
 * 该不该重画?
 *  - 无档案材料 → 否(没有诚实可画的东西)
 *  - 从没画过 + 有材料 → 是(首次)
 *  - 档案没比上次画像新 → 否(CC 没学到新东西)
 *  - 档案更新了但没到最短间隔 → 否(别抖动)
 *  - 档案更新了且过了最短间隔 → 是
 */
export function shouldRepaintPortrait(a: {
  portraitAt: number | null   // 上次画像时间(portrait.json generated_at),null=从没画过
  profileMtime: number | null // 档案材料最新 mtime,null=无材料
  now: number
}): boolean {
  if (a.profileMtime === null) return false
  if (a.portraitAt === null) return true
  if (a.profileMtime <= a.portraitAt) return false
  return a.now - a.portraitAt >= PORTRAIT_MIN_INTERVAL_MS
}

export interface PortraitArtistDeps {
  adminChatId: string
  /** 上次画像时刻(epoch ms),null=从没画过。 */
  portraitGeneratedAt: () => number | null
  /** 档案材料(_profile.json / _overview.md / profile.md)最新 mtime,null=无。 */
  profileMtime: () => number | null
  /** 真正的重画(= memoryLlmOps.generatePortrait 绑定到 owner chat)。 */
  generate: (adminChatId: string) => Promise<{ ok: boolean; error?: string }>
  log: (tag: string, line: string) => void
  now?: () => number
}

export async function runPortraitArtist(deps: PortraitArtistDeps): Promise<{ painted: boolean }> {
  const now = deps.now ?? (() => Date.now())
  try {
    if (!shouldRepaintPortrait({
      portraitAt: deps.portraitGeneratedAt(),
      profileMtime: deps.profileMtime(),
      now: now(),
    })) return { painted: false }
    const r = await deps.generate(deps.adminChatId)
    if (r.ok) {
      deps.log('PORTRAIT', 'refreshed — CC 对主人的理解又深了一点,小像随之更新')
      return { painted: true }
    }
    deps.log('PORTRAIT', `refresh skipped: ${r.error ?? 'unknown'}`)
    return { painted: false }
  } catch (err) {
    deps.log('PORTRAIT', `artist step failed: ${err instanceof Error ? err.message : err}`)
    return { painted: false }
  }
}
