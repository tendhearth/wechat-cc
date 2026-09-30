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
