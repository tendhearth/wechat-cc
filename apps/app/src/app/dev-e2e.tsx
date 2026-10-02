import * as SecureStore from 'expo-secure-store'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { E2E_BUILD } from '../e2e-build'
import { e2eOp, restorePairing, stashPairing, stashStatus } from '../state/e2e-stash'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'

// 只在开发构建与真机验收构建(src/e2e-build.ts)里生效(文案豁免 i18n,同 dev-push-key):真机验收脚本(scripts/device-e2e.ts)用它把主人的配对收起来 / 放回去。
// 发布构建里 +native-intent 已把深链改回此刻;万一进来了 ⇒ 回此刻,什么都不动。改完钥匙串由脚本杀掉 app 再冷启动,内存里的会话不在这里改。
// 钥匙串选项与 net/secure-store.ts 的 credentials 相同(配对记录落在主 app 的私有组)。
const OPTS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }

export default function DevE2E() {
  const { op } = useLocalSearchParams<{ op?: string }>()
  const { c } = useTheme()
  const [state, setState] = useState('pending')
  const done = useRef<string | null>(null)
  useEffect(() => {
    if (!__DEV__ && !E2E_BUILD) return
    // 同一个 op 只做一次(重渲染 / effect 重跑时第二次「收」会报 already_stashed,把真实结果盖掉)
    if (done.current === (op ?? '')) return
    done.current = op ?? ''
    const which = e2eOp(op)
    if (!which) { setState('rejected'); return }
    const run = which === 'stash' ? stashPairing(SecureStore, OPTS) : which === 'restore' ? restorePairing(SecureStore, OPTS) : stashStatus(SecureStore, OPTS)
    void run.then(r => setState(`${which}-${r}`), () => setState(`${which}-failed`))
  }, [op])
  if (!__DEV__ && !E2E_BUILD) return <Redirect href="/" />
  return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: c.paper }}><Txt testID={`dev-e2e-${state}`} role="small" tone="inkSoft">{state}</Txt></View>
}
