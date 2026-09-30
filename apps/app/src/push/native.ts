import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { Linking, Platform } from 'react-native'
import { t, type Lang } from '../i18n'
import { makePushKeyStore, PUSH_KEY_SERVICE } from './key-store'
import { permState, type PermissionState } from './register'

// expo-notifications 与钥匙串的真实例。纯逻辑在 register.ts / key-store.ts。日志只有步骤名与错误类名。

const extra = (Constants.expoConfig?.extra ?? {}) as { apnsEnv?: string; keychainGroup?: string }
export const apnsEnv: 'development' | 'production' = extra.apnsEnv === 'production' ? 'production' : 'development'

/**
 * 推送密钥记录的读 / 写 / 删都带同一组选项:service `tendhearth.push`、iOS access group = extra.keychainGroup
 * (与通知扩展共享,app.config.js 算出)、AFTER_FIRST_UNLOCK(扩展要在锁屏时、首次解锁之后读)。
 * 安卓没有 access group;Kotlin 服务按 service + 键名读同一份 expo-secure-store。
 */
export const pushKeys = makePushKeyStore(SecureStore, {
  shared: {
    keychainService: PUSH_KEY_SERVICE,
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    ...(Platform.OS === 'ios' && typeof extra.keychainGroup === 'string' ? { accessGroup: extra.keychainGroup } : {}),
  },
  local: { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
})

const devLog = (l: string) => { if (__DEV__) console.log(`[push] ${l}`) }

/**
 * 撤销 / 解除配对(会话的 clearStored 调它):推送密钥与登记指纹当场清掉,再向系统注销本机推送 ——
 * 电脑那边若还留着登记(解除时离线),推送也到不了了。重新配对时 getDevicePushTokenAsync 会重新注册。
 * 注销失败只记一行;密钥清失败才抛(clearStored 记一行)。
 */
export const pushForget = {
  async clear(): Promise<void> {
    const [keys, unreg] = await Promise.allSettled([pushKeys.clear(), Notifications.unregisterForNotificationsAsync()])
    if (unreg.status === 'rejected') devLog(`unregister failed (${unreg.reason instanceof Error ? unreg.reason.name : 'unknown'})`)
    if (keys.status === 'rejected') throw keys.reason
  },
}

export const perms = {
  get: async (): Promise<PermissionState> => permState(await Notifications.getPermissionsAsync()),
  request: async (): Promise<PermissionState> =>
    permState(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } })),
}

export async function nativeToken(): Promise<string> {
  const tok = await Notifications.getDevicePushTokenAsync()
  if (typeof tok.data !== 'string') throw new Error('token_shape')
  return tok.data
}

/** 安卓:与 Kotlin 服务同样的两个渠道 id、同样的名字(plugins/push-strings.test.ts 钉住)。 */
export async function prepareChannels(lang: Lang): Promise<void> {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync('decide', { name: t(lang, 'push.channelDecide'), importance: Notifications.AndroidImportance.HIGH })
  await Notifications.setNotificationChannelAsync('updates', { name: t(lang, 'push.channelUpdates'), importance: Notifications.AndroidImportance.DEFAULT })
}

/** iOS:扩展设的 category 都在这里注册,不带任何动作(通知本身从不执行操作,spec §1)。 */
export const NOTIFICATION_CATEGORIES = ['th.approval', 'th.question', 'th.done', 'th.failed', 'th.test'] as const
export async function registerCategories(): Promise<void> {
  if (Platform.OS !== 'ios') return
  for (const id of NOTIFICATION_CATEGORIES) await Notifications.setNotificationCategoryAsync(id, [])
}

export const openSystemSettings = () => { void Linking.openSettings() }

// app 在前台:不弹系统横幅,由 app 自己的横幅显示(spec §7「正在用 app 时」);通知仍进通知中心。
// 安卓的通知由我们自己的 FirebaseMessagingService 发,不经过这里(点开走 tendhearth://push-open 深链)。
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
})
