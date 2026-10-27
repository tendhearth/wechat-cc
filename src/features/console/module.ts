/**
 * 桌面控制台接进 daemon 的那一份(模块清单在 index.ts):它要的从地基里填。只有 daemon-modules.ts import 这个文件。
 */
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import { consoleFeature } from './index'

/** 桌面以前起 CLI 读写的对话页、会话名单、观察 / 里程碑 / 决策、头像 ……(架构终态 F6):只挂路由。 */
export function consoleModule(f: Foundation): DaemonModule {
  const { stateDir, db } = f
  return consoleFeature({ stateDir, db, conversationStore: f.conversationStore })
}
