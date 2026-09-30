import { PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'

/**
 * 说一句 / 交办新事项的正文上限。daemon 两处都是 20 000:POST /m/api/matter/say 用 PHONE_SAY_MAX_CHARS;
 * 交办走 parseEntryInput(ENTRY_LIMITS.text,超了回 invalid_text)。两者今天相等,手机统一用协议包常量。
 */
export const COMPOSE_MAX_CHARS = PHONE_SAY_MAX_CHARS

/** 超了就在手机上拦下,不发(发了也必然被拒,不是「稍后再试」)。 */
export const composeTooLong = (text: string): boolean => text.length > COMPOSE_MAX_CHARS
