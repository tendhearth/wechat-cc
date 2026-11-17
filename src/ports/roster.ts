import type { RosterResponseT } from '@wechat-cc/protocol'
/** daemon 名单只读口;HTTP 与手机订阅读同一个实例。 */
export interface RosterReader { read(scope: 'operator' | 'device'): RosterResponseT }
