/**
 * 提醒接进 daemon 的那一份(模块清单在 index.ts)。只有 daemon-modules.ts import 这个文件。
 */
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import type { WiredDeps } from '../../daemon/wiring'
import type { Activity } from '../../daemon/bootstrap/wire-activity'
import { isOwnerOf } from '../../daemon/owner-chat'
import { remindersFeature } from './index'

export function remindersModule(f: Foundation): DaemonModule<void> {
  const { db } = f
  return remindersFeature({
    db, isOwner: isOwnerOf(f.stateDir), needs: ['wired', 'activity'],
    speech: (c) => c.get<WiredDeps>('wired').speech,
    activityLog: (c) => c.get<Activity>('activity').activityLog,
  })
}
