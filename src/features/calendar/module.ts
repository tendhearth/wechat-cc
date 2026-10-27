/**
 * 读日历和提醒接进 daemon 的那一份(模块清单在 index.ts)。只有 daemon-modules.ts import 这个文件。
 */
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import { isOwnerOf } from '../../daemon/owner-chat'
import { calendarFeature, type CalendarFeature } from './index'

export function calendarModule(f: Foundation): DaemonModule<CalendarFeature> {
  const { stateDir } = f
  return calendarFeature({ stateDir, isOwner: isOwnerOf(stateDir) })
}
