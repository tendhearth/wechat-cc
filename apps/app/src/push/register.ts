import { pushTokenValid, type PushPlatformT } from '@wechat-cc/protocol'
import { BackendError } from '../backend/types'
import type { Lang } from '../i18n'
import type { PushKeyStore } from './key-store'

// 推送登记(spec §6 最后两步、§7「token 生命周期」)。纯逻辑:expo-notifications 与钥匙串由调用方注入。
// 纯 TS(根目录测试会 import):不引 react / react-native / expo-*。
// 日志只写步骤名与错误码 / 错误类名,从不写令牌、密钥、APNs / FCM token,也不写错误的 message(可能夹着 token)。

export type PermissionState = 'granted' | 'denied' | 'undetermined'
/**
 * unavailable = 电脑没接推送(还没上 v2 中继,push_not_wired);
 * failed = 其余失败(拿不到本机 APNs / FCM token、token 形状不对、撤销、参数错……)。
 */
export type PushStatus = 'idle' | 'registered' | 'denied' | 'unavailable' | 'offline' | 'failed'
export type PushDeps = {
  os: 'ios' | 'android'
  apnsEnv: 'development' | 'production'
  deviceId: string
  deviceToken: string
  /** 设置里的语言覆盖(null = 跟系统);写进推送密钥记录,原生端按它选语言。 */
  lang: Lang | null
  keys: PushKeyStore
  permission(): Promise<PermissionState>
  requestPermission(): Promise<PermissionState>
  /** 安卓 13+ 要先有通知渠道,系统才肯弹权限框;iOS 不传。 */
  prepare?(): Promise<void>
  nativeToken(): Promise<string>
  register(platform: PushPlatformT, token: string): Promise<void>
  now(): number
  log(line: string): void
}

/** 同一 token 每天至少重登一次:daemon 那边的登记文件丢了 / 中继换过,都能自愈。 */
export const REREGISTER_MS = 86_400_000

export function platformFor(os: 'ios' | 'android', apnsEnv: 'development' | 'production'): PushPlatformT {
  if (os === 'android') return 'fcm'
  return apnsEnv === 'production' ? 'apns' : 'apns_sandbox'
}

/** expo-notifications 的权限结果 → 三态。iOS 的临时授权(provisional = 3、ephemeral = 4)也能收通知。 */
export function permState(p: { status: string; granted: boolean; ios?: { status?: number } }): PermissionState {
  if (p.granted) return 'granted'
  if (p.ios?.status === 3 || p.ios?.status === 4) return 'granted'
  return p.status === 'undetermined' ? 'undetermined' : 'denied'
}

/**
 * 什么时候跑 syncPush。已登记也照跑:token 可能悄悄换了、通知权限可能刚在系统设置里被关了,
 * 这两件事只有再同步一次才看得见。便宜:同一 token 24 小时内 syncPush 靠指纹跳过登记请求。
 * (保留状态 / 触发参数,调用点读起来是「这个时机要不要同步」。)
 */
export function shouldSync(_status: PushStatus, _trigger: 'online' | 'foreground' | 'token'): boolean {
  return true
}

const errName = (e: unknown) => (e instanceof BackendError ? e.code : e instanceof Error ? e.name : 'unknown')

export async function syncPush(d: PushDeps, opts: { force?: boolean } = {}): Promise<PushStatus> {
  // 先存密钥:权限还没给、电脑还没连上时,之后到的推送扩展照样能解开。
  await d.keys.ensure(d.deviceToken, d.lang)
  let perm = await d.permission()
  if (perm === 'undetermined') {
    await d.prepare?.()
    perm = await d.requestPermission()
  }
  if (perm !== 'granted') return 'denied'
  let token: string
  try { token = await d.nativeToken() } catch (e) { d.log(`push: native token failed (${errName(e)})`); return 'failed' }
  const platform = platformFor(d.os, d.apnsEnv)
  if (!pushTokenValid(platform, token)) { d.log(`push: native token bad shape (${platform})`); return 'failed' }
  const fp = `${d.deviceId}|${platform}|${token}`
  const prev = await d.keys.loadReg()
  if (!opts.force && prev && prev.fp === fp && d.now() - prev.at < REREGISTER_MS) return 'registered'
  try {
    await d.register(platform, token)
  } catch (e) {
    const code = errName(e)
    d.log(`push: register failed (${code})`)
    if (code === 'unavailable') return 'unavailable'
    if (code === 'offline' || code === 'timeout') return 'offline'
    return 'failed'
  }
  await d.keys.saveReg({ fp, at: d.now() })
  return 'registered'
}
