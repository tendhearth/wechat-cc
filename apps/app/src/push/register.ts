import { pushTokenValid, type PushPlatformT } from '@wechat-cc/protocol'
import { BackendError, type ConnState } from '../backend/types'
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

export type SyncTrigger = 'online' | 'foreground' | 'token'
export type SyncAction = 'none' | 'sync' | 'force' | 'recheck'

/**
 * PushProvider 的调度(纯函数)。只在真连接、在线时登记;token 变了强制重登。
 * - online:每条连接(epoch)只同步一次 —— 已登记也同步(裁决 C3,去重交给 syncPush 的指纹);
 *   同一 epoch 上重复的「上线」(依赖变了引起的重渲染)不再跑,unavailable / failed 不会反复 POST。
 * - foreground:在线就跑;还没连上且之前被拒 ⇒ recheck(只在本机重查权限,设置页状态跟着变,Review Focus 3)。
 * - 撤销后什么都不做。
 */
export function nextSyncAction(s: {
  live: boolean; conn: ConnState; status: PushStatus; trigger: SyncTrigger; epoch: number; lastEpoch: number | null
}): SyncAction {
  if (!s.live || s.conn === 'revoked') return 'none'
  if (s.conn !== 'online') return s.trigger === 'foreground' && s.status === 'denied' ? 'recheck' : 'none'
  if (!shouldSync(s.status, s.trigger)) return 'none'
  if (s.trigger === 'token') return 'force'
  if (s.trigger === 'online' && s.lastEpoch === s.epoch) return 'none'
  return 'sync'
}

export type PushRunner = {
  /** 按 nextSyncAction 决定跑不跑;跑着的时候来的触发排队,跑完补一次(token 优先)。从不拒绝。 */
  trigger(t: SyncTrigger): Promise<void>
  /** 配对换了 / 解除:状态回 idle,正在跑的那次结果作废。 */
  reset(): void
  /** 等正在跑的(连同排队补跑的)都结束 —— 清推送密钥前先等它,免得它刚清完又被 syncPush 写回。 */
  idle(): Promise<void>
  status(): PushStatus
}

const RANK: Record<SyncTrigger, number> = { online: 0, foreground: 1, token: 2 }

/** 单飞:同一时刻最多一次 syncPush;syncPush 抛了(钥匙串首次解锁前读不了、存指纹失败)⇒ failed,只记错误类名。 */
export function makePushRunner(o: {
  ctx(): { live: boolean; conn: ConnState; epoch: number }
  sync(force: boolean): Promise<PushStatus>
  recheck(): Promise<PermissionState>
  onStatus(s: PushStatus): void
  log(line: string): void
}): PushRunner {
  let gen = 0
  let status: PushStatus = 'idle'
  let lastEpoch: number | null = null
  let running: Promise<void> | null = null
  let queued: SyncTrigger | null = null

  const settle = (my: number, next: PushStatus) => {
    if (my !== gen) return
    status = next
    o.onStatus(next)
  }

  function trigger(t: SyncTrigger): Promise<void> {
    const c = o.ctx()
    const action = nextSyncAction({ ...c, status, trigger: t, lastEpoch })
    if (action === 'none') return running ?? Promise.resolve()
    if (running) {
      if (queued === null || RANK[t] > RANK[queued]) queued = t
      return running
    }
    const my = gen
    if (action !== 'recheck') lastEpoch = c.epoch
    const job = async () => {
      try {
        if (action === 'recheck') settle(my, (await o.recheck()) === 'granted' ? 'offline' : 'denied')
        else settle(my, await o.sync(action === 'force'))
      } catch (e) {
        o.log(`push: ${action === 'recheck' ? 'recheck' : 'sync'} threw (${errName(e)})`)
        settle(my, 'failed')
      }
    }
    const p: Promise<void> = job().then(() => {
      running = null
      const q = queued
      queued = null
      // reset 会清空队列,所以此刻还在队里的都是 reset 之后(当前代)来的:不论旧的这次属于哪一代都补跑。
      if (q !== null) return trigger(q)
    })
    running = p
    return p
  }

  return {
    trigger,
    reset() {
      gen++
      queued = null
      lastEpoch = null
      status = 'idle'
      o.onStatus('idle')
    },
    async idle() { while (running) await running },
    status: () => status,
  }
}

/**
 * 推送 token 监听的过滤(2026-10-01 真机验收抓到的重试风暴):iOS 上 getDevicePushTokenAsync 每调一次,
 * expo-notifications 都会把拿到的 token 再广播给 addPushTokenListener —— 监听里无条件 trigger('token')(强制重登)
 * ⇒ 同步里又调 getDevicePushTokenAsync ⇒ 又广播 ⇒ 每 0.6 秒一次 POST /m/api/push/register,停不下来。
 * 只有 token 跟最近一次见到的(自己拿到的或监听收到的)不一样,才算「token 刷新」。
 */
export function makeTokenWatch(): { note(token: string): void; changed(token: unknown): boolean } {
  let last: string | null = null
  return {
    note(token) { last = token },
    changed(token) {
      if (typeof token !== 'string' || token === '' || token === last) return false
      last = token
      return true
    },
  }
}
