import type { MessageKey } from '../i18n'
import { parsePairLink, type LinkError, type ParsedLink } from '../net/link'
import type { PairErrorCode } from '../net/pairing'

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
