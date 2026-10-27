/**
 * 打猎接进 daemon 的那一份(模块清单在 index.ts):它要的从地基里填。只有 daemon-modules.ts import 这个文件。
 */
import { log } from '../../lib/log'
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import { huntFeature } from './index'

/** init 只跑「默认关」那次的一次性开机步骤(以前在地基里,排在 internal-api 开门、任何伙伴那一拍之前)。 */
export function huntModule(f: Foundation): DaemonModule<void> {
  const { stateDir } = f
  return huntFeature({
    needs: [],
    deps: () => ({ stateDir, chatPrefs: f.chatPrefs, log: (t, l) => log(t, l) }),
  })
}
