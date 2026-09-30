import type { MessageKey } from '../i18n'
import type { LinkError } from '../net/link'
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
