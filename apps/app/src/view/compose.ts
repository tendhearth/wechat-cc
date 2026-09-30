import { PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'

/** 与 daemon POST /m/api/matter/say 的上限一致:超了就在手机上拦下,不发(发了也必然被拒,不是「稍后再试」)。 */
export const sayTooLong = (text: string): boolean => text.length > PHONE_SAY_MAX_CHARS
