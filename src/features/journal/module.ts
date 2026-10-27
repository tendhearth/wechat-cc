/**
 * 伙伴日志(背包)接进 daemon 的那一份(模块清单在 index.ts):表是地基里那一份。只有 daemon-modules.ts import 这个文件。
 */
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import { journalFeature } from './index'

export function journalModule(f: Foundation): DaemonModule<void> {
  const { stateDir } = f
  return journalFeature({
    needs: [],
    deps: () => ({ stateDir, journal: f.journal }),
  })
}
