import { useEffect, useState } from 'react'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { Text, View } from 'react-native'
import { devPushKeyAction, devPushToken } from '../push/dev-token'
import { perms, pushKeys } from '../push/native'
import { useSession } from '../state/session'

// 只在开发构建里生效(裁决 C13,文案豁免 i18n):把一个合成的开发令牌(dev + 48 位 hex,和真设备令牌的形状不同)推出的推送密钥
// 存进共享钥匙串、要通知权限,并记在内存里给 PushRouter 兜底解密(simctl push 不跑扩展、演示没有配对),让 scripts/sim-push.ts 在模拟器上验证。发布构建里 +native-intent 已把深链改回此刻;万一进来了 ⇒ 回此刻,什么都不存。
// 已配对的开发构建:什么都不写(共享钥匙串里放着真配对的推送密钥),只显示一句说明。
export default function DevPushKey() {
  const { token } = useLocalSearchParams<{ token?: string }>()
  const paired = useSession().pairing !== null
  const [state, setState] = useState<'pending' | 'ok' | 'failed' | 'rejected' | 'paired'>('pending')
  useEffect(() => {
    const action = devPushKeyAction(__DEV__, token, paired)
    if (action === 'none') return
    if (action !== 'apply') { setState(action); return }
    const tok = token as string
    // 演示模式不会去要通知权限(登记只在配对后跑)⇒ 这里顺手要一次,simctl push 的通知才显示;拒了也照样 ok(只影响显示)。
    void pushKeys.ensure(tok, null)
      .then(() => { devPushToken.set(tok); return perms.request().catch(() => null) })
      .then(() => setState('ok'), () => setState('failed'))
  }, [token, paired])
  if (!__DEV__) return <Redirect href="/" />
  const note = state === 'paired' ? 'paired: dev push key not written (would overwrite the real push key)' : state
  return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}><Text testID={`dev-push-key-${state}`}>{note}</Text></View>
}
