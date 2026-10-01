import type { MessageKey } from '../i18n'
import { parsePairLink, type LinkError, type ParsedLink } from '../net/link'
import type { PairErrorCode } from '../net/pairing'
import { systemPairLink } from '../net/system-link'

export function linkErrorKey(e: LinkError): MessageKey {
  return e === 'remote_off' ? 'pair.errRemoteOff' : e === 'bad_link' ? 'pair.errBadLink' : 'pair.errNotALink'
}
export function pairErrorKey(e: PairErrorCode): MessageKey {
  switch (e) {
    case 'expired': return 'pair.errExpired'
    case 'device_limit': return 'pair.errDeviceLimit'
    case 'offline': return 'pair.errOffline'
    case 'too_old': return 'pair.errTooOld'
    default: return 'pair.errUnknown'
  }
}

/** 同步单飞闸:不等重渲染,同一帧里的第二次点击也进不来。 */
export function makeGate() {
  let on = false
  return {
    enter(): boolean { if (on) return false; on = true; return true },
    leave(): void { on = false },
    busy(): boolean { return on },
  }
}

/**
 * 系统链接 → 确认卡(spec §6.3):候选依次是暂存格里的原链接、expo-linking 的 getLinkingURL()(兜底)。
 * 第一个能解析的胜出;都解析不了且没有一个是「锚点在但坏了」⇒ 「没带全」(用 app 内扫码再扫一次)。
 */
export function linkIntake(cands: Array<string | null | undefined>): { ok: true; link: ParsedLink } | { ok: false; key: MessageKey } {
  let worst: LinkError | null = null
  for (const c of cands) {
    if (!c) continue
    const r = parsePairLink(c)
    if (r.ok) return r
    if (r.error !== 'not_a_link') worst = r.error
  }
  return { ok: false, key: worst ? linkErrorKey(worst) : 'pair.errLinkIncomplete' }
}

/** 正在配对(working)时来的新链接不打断当前流程(Review Focus 5)。 */
export function acceptsIncomingLink(phase: 'intro' | 'scan' | 'confirm' | 'working' | 'error'): boolean {
  return phase !== 'working'
}

export type IncomingLinkDeps = {
  /** 暂存格(rewriteSystemPath 放进来的原链接),取后即焚。 */
  take: () => string | null
  /** expo-linking getLinkingURL():原生缓存的最近一条链接(兜底:路由那边锚点丢了时)。 */
  readNative: () => string | null
  /** expo-linking clearInitialURL()。 */
  clearNative: () => void
  dev: boolean
}
export type IncomingLinkResult = { k: 'ignore' } | { k: 'confirm'; link: ParsedLink } | { k: 'error'; key: MessageKey }

/**
 * 配对页收到 from=link(spec §6.3)。不管接不接,暂存格取走、原生缓存清掉 —— 令牌不在任何一格里久留,
 * 下一条锚点丢了的链接也不会拿到这条旧的当兜底(iOS 热启动的通用链接只在缓存为空时才写入)。
 * 正在配对 / 闸门忙 ⇒ 不读缓存、不打断(ignore);否则先读兜底再清,交给 linkIntake。只到确认卡,永不自动配对。
 */
export function intakeIncomingLink(phase: 'intro' | 'scan' | 'confirm' | 'working' | 'error', busy: boolean, d: IncomingLinkDeps): IncomingLinkResult {
  const pending = d.take()
  const accept = !busy && acceptsIncomingLink(phase)
  let native: string | null = null
  if (accept) { try { native = d.readNative() } catch { native = null } }
  try { d.clearNative() } catch { /* 网页端是空操作 */ }
  if (!accept) return { k: 'ignore' }
  const r = linkIntake([pending, native ? systemPairLink(native, d.dev) : null])
  return r.ok ? { k: 'confirm', link: r.link } : { k: 'error', key: r.key }
}
