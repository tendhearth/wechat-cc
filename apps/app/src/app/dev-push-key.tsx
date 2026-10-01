import { useEffect, useState } from 'react'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { Text, View } from 'react-native'
import { isDevPushToken } from '../push/key-store'
import { pushKeys } from '../push/native'

// 只在开发构建里生效(裁决 C13,文案豁免 i18n):把一个合成的开发令牌(dev + 48 位 hex,和真设备令牌的形状不同)推出的推送密钥
// 存进共享钥匙串,让 scripts/sim-push.ts 在模拟器上验证。发布构建里 +native-intent 已把深链改回此刻;万一进来了 ⇒ 回此刻,什么都不存。
export default function DevPushKey() {
  const { token } = useLocalSearchParams<{ token?: string }>()
  const [state, setState] = useState<'pending' | 'ok' | 'failed' | 'rejected'>('pending')
  useEffect(() => {
    if (!__DEV__) return
    if (typeof token !== 'string' || !isDevPushToken(token)) { setState('rejected'); return }
    void pushKeys.ensure(token, null).then(() => setState('ok'), () => setState('failed'))
  }, [token])
  if (!__DEV__) return <Redirect href="/" />
  return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><Text testID={`dev-push-key-${state}`}>{state}</Text></View>
}
