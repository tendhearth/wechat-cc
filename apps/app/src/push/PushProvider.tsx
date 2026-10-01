import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Notifications from 'expo-notifications'
import { AppState, Platform } from 'react-native'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { useSession } from '../state/session'
import { leftoverPushKey, stillClearPushKey } from '../state/session-store'
import { apnsEnv, nativeToken, openSystemSettings, perms, prepareChannels, pushKeys, registerCategories } from './native'
import { makePushRunner, syncPush, type PushStatus } from './register'

type PushCtx = { status: PushStatus; openSettings(): void; sendTest(): Promise<{ ok: boolean; code: string }> }
const Ctx = createContext<PushCtx | null>(null)
const devLog = (l: string) => { if (__DEV__) console.log(`[push] ${l}`) } // 只有步骤名与错误码 / 类名
const errName = (e: unknown) => (e instanceof Error ? e.name : 'unknown')

/**
 * 推送登记的生命周期(spec §7「token 生命周期」):每条连接上线一次 / 回前台 / token 刷新都同步(调度见 register.ts
 * nextSyncAction + makePushRunner:单飞、接住异常、同一连接不重复 POST)。
 * 撤销与解除配对由会话的 clearStored 清密钥并注销;这里在撤销后 / 冷启动没配对时,等正在跑的同步停下再清一遍
 * (防 syncPush 刚被清掉又写回)。安卓的 token 监听不一定触发(我们自己的消息服务收 onNewToken 不上报),
 * 靠上线 / 回前台时重拿 token 比指纹发现变化。
 */
export function PushProvider({ children }: { children: ReactNode }) {
  const { backend } = useBackendCtx()
  const session = useSession()
  const lang = useLang()
  const conn = useConnection()
  const [status, setStatus] = useState<PushStatus>('idle')
  const pairing = session.pairing
  const live = backend.mode === 'live' && pairing !== null
  const revoked = conn.state === 'revoked'

  const latest = useRef({ live, conn, pairing, backend, langOverride: session.langOverride, lang })
  latest.current = { live, conn, pairing, backend, langOverride: session.langOverride, lang }
  /** 推送密钥的写(ensure)在飞时,清之前先等它。 */
  const keyWrite = useRef<Promise<unknown>>(Promise.resolve())

  const runner = useMemo(() => makePushRunner({
    ctx: () => ({ live: latest.current.live, conn: latest.current.conn.state, epoch: latest.current.conn.epoch }),
    sync: force => {
      const L = latest.current
      if (!L.pairing) return Promise.resolve<PushStatus>('idle')
      const b = L.backend
      return syncPush({
        os: Platform.OS === 'ios' ? 'ios' : 'android', apnsEnv, deviceId: L.pairing.deviceId, deviceToken: L.pairing.deviceToken,
        lang: L.langOverride, keys: pushKeys, permission: perms.get, requestPermission: perms.request,
        prepare: () => prepareChannels(latest.current.lang), nativeToken, register: (p, tok) => b.registerPush(p, tok),
        now: Date.now, log: devLog,
      }, { force })
    },
    recheck: perms.get,
    onStatus: setStatus,
    log: devLog,
  }), [])

  // 记下调用时的配对(撤销)或 null(没配对);等停下后若这期间重新配对了就不清(stillClearPushKey)。
  const clearAfterIdle = () => {
    const captured = latest.current.pairing
    void Promise.all([runner.idle(), keyWrite.current]).then(() => {
      const L = latest.current
      if (!stillClearPushKey(captured, { pairing: L.pairing, revoked: L.conn.state === 'revoked' })) return
      return pushKeys.clear().catch(e => devLog(`pushClear failed (${errName(e)})`))
    })
  }

  useEffect(() => { void registerCategories().catch(e => devLog(`categories failed (${errName(e)})`)) }, [])
  // 换配对 / 换后端 ⇒ 调度从头来(正在跑的那次结果作废)。要排在「上线」那条 effect 前面。
  useEffect(() => { runner.reset() }, [runner, pairing, backend])
  // 冷启动 / 解除配对后:没配对却可能还留着推送密钥(上次清失败、老版本升级)⇒ 清。
  useEffect(() => { if (leftoverPushKey(session.ready, pairing)) clearAfterIdle() }, [session.ready, pairing]) // eslint-disable-line react-hooks/exhaustive-deps
  // 被撤销:会话已清过一次;等在飞的同步 / 写停下再清一遍,状态回 idle(设置页不再显示「已开启」)。
  useEffect(() => { if (revoked) { runner.reset(); clearAfterIdle() } }, [revoked]) // eslint-disable-line react-hooks/exhaustive-deps
  // 配对了就先把密钥存好(离线也存):之后到的推送扩展照样能解。语言覆盖变了也更新记录。撤销后不写(裁决 C4)。
  useEffect(() => {
    if (!live || revoked || !pairing) return
    keyWrite.current = pushKeys.ensure(pairing.deviceToken, session.langOverride).catch(e => devLog(`pushEnsure failed (${errName(e)})`))
  }, [live, revoked, pairing, session.langOverride])

  useEffect(() => { void runner.trigger('online') }, [runner, live, conn.state, conn.epoch])
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => { if (s === 'active') void runner.trigger('foreground') })
    return () => sub.remove()
  }, [runner])
  useEffect(() => {
    const sub = Notifications.addPushTokenListener(() => { void runner.trigger('token') })
    return () => sub.remove()
  }, [runner])

  const value = useMemo<PushCtx>(() => ({
    status,
    openSettings: openSystemSettings,
    sendTest: () => backend.testPush(),
  }), [status, backend])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePush(): PushCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('PushProvider missing')
  return c
}
