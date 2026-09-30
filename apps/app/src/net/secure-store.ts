import * as SecureStore from 'expo-secure-store'
import { makeCredentialStore } from './credentials'

// AFTER_FIRST_UNLOCK:下一份计划的 iOS 通知扩展要在锁屏后台读推送密钥;与扩展共享的 access group 也在那份计划里加。
export const credentials = makeCredentialStore(SecureStore, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK })
