import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Lang } from '../i18n'
import { LangOverrideCtx } from '../i18n/useLang'
import type { CredentialStore } from '../net/credentials'
import type { PairingRecord } from '../net/pairing'
import { clearStored, loadSession, quietly } from './session-store'
import { matterInputState } from './matter-inputs'
import type { InputJournal } from './input-journal'
import { setPairingScope } from './drafts'

// 会话:配对记录与语言偏好落钥匙串;「已看过欢迎页」= 已配对,或这次打开点过「先看看」。
type Session = {
  ready: boolean
  loadError: boolean
  retryLoad(): void
  pairingEpoch: number
  pairingTransition: boolean
  inputScope: string | null
  pairing: PairingRecord | null
  setPaired(r: PairingRecord): Promise<void>
  /** 被电脑撤销:只清钥匙串(配对记录 + 推送密钥);内存里的配对留着,后端停在 revoked,页面显示最后同步的内容 + 重新配对。 */
  dropStoredPairing(captured?: PairingRecord | null, epoch?: number): void
  /** 用户解除配对:钥匙串(配对记录 + 推送密钥)与内存都清,回欢迎页。 */
  forgetPairing(): Promise<void>
  /** 启动核验发现配对已失效(恢复回来的旧记录,D8):清钥匙串与内存,回欢迎页并说明。 */
  forgetStale(captured?: PairingRecord | null, epoch?: number): void
  staleNotice: boolean
  seenWelcome: boolean
  markWelcomeSeen(): void
  setSeenWelcome(v: boolean): void
  langOverride: Lang | null
  setLangOverride(l: Lang | null): void
}

const SessionCtx = createContext<Session | null>(null)

/** push:撤销 / 解除配对时一起清推送密钥(并注销本机推送)的那一方;失败只记一行,不连累配对的清除。 */
export function SessionProvider({ children, store, push, inputs }: { children: ReactNode; store: CredentialStore; push: { clear(): Promise<void> }; inputs?: InputJournal }) {
  const [ready, setReady] = useState(false)
  const [pairing, setPairing] = useState<PairingRecord | null>(null)
  const [staleNotice, setStale] = useState(false)
  const [seenWelcome, setSeen] = useState(false)
  const [langOverride, setLang] = useState<Lang | null>(null)
  const [inputScope, setInputScope] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [pairingEpoch, setEpoch] = useState(0)
  const [pairingTransition, setTransition] = useState(false)
  const operation = useRef(0)
  const intendedPairing = useRef<PairingRecord | null>(null)
  const credentialTail = useRef<Promise<unknown>>(Promise.resolve())
  const serialize = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = credentialTail.current.then(fn, fn); credentialTail.current = next.catch(() => {}); return next
  }
  useEffect(() => {
    let alive = true
    const at = ++operation.current
    if (inputs) matterInputState.configure(inputs)
    // 配对读取失败与确定未配对分开;临时不可读时不清日志,等待显式重读。
    void loadSession(store).then(async ({ pairing: p, lang, pairingReadFailed }) => {
      if (!alive || operation.current !== at) return
      if (pairingReadFailed) { setLang(lang); setLoadError(true); return }
      intendedPairing.current = p
      // Restoring the Keychain journal finishes before routes mount. Failure is visible and sends stay locked.
      try { await matterInputState.activate(p) } catch { /* recovery state supplies the notice/retry */ }
      if (!alive || operation.current !== at) return
      const scope = matterInputState.recovery().scope
      setInputScope(scope); setPairingScope(scope ?? 'none')
      setPairing(p); setSeen(p !== null); setLang(lang); setEpoch(at); setLoadError(false); setReady(true)
    })
    return () => { alive = false }
  }, [store, inputs, loadAttempt])
  const value = useMemo<Session>(() => ({
    ready, pairing, inputScope, loadError, pairingEpoch, pairingTransition,
    retryLoad() { operation.current++; matterInputState.suspend(); setReady(false); setLoadError(false); setLoadAttempt(n => n + 1) },
    async setPaired(r) {
      const previous = intendedPairing.current
      const at = ++operation.current
      // All callbacks from the previous backend become invalid before the first credential await.
      intendedPairing.current = r; setTransition(true)
      matterInputState.suspend()
      try {
        await serialize(async () => { if (operation.current !== at) throw new Error('pairing_changed'); await store.save(r) })
      } catch (e) {
        if (operation.current === at) {
          intendedPairing.current = previous
          try { await matterInputState.activate(previous) } catch {}
          if (operation.current === at) { setInputScope(matterInputState.recovery().scope); setEpoch(at); setTransition(false) }
        }
        throw e
      }
      if (operation.current !== at) throw new Error('pairing_changed')
      const reset = matterInputState.activate(r, false)
      try { await reset } catch (e) {
        if (e instanceof Error && e.message === 'input_scope') {
          if (operation.current === at) { setEpoch(at); setTransition(false) }
          throw e
        }
        // Credentials succeeded, but journal cleanup may still need an explicit retry.
      }
      if (operation.current !== at) throw new Error('pairing_changed')
      const scope = matterInputState.recovery().scope
      if (!scope && matterInputState.recovery().phase === 'ready') throw new Error('input_scope')
      setPairingScope(scope ?? 'none'); setInputScope(scope); setPairing(r); setSeen(true); setStale(false); setEpoch(at); setTransition(false)
    },
    dropStoredPairing(captured = intendedPairing.current, epoch = operation.current) {
      if (captured !== intendedPairing.current || epoch !== operation.current || pairingTransition) return
      const at = ++operation.current
      setPairingScope('revoked'); setInputScope(null)
      quietly(Promise.all([matterInputState.clear(), serialize(async () => { if (operation.current === at) await clearStored(store, push) })]), 'clear')
    },
    async forgetPairing() {
      const at = ++operation.current; intendedPairing.current = null
      setPairingScope('none'); setInputScope(null)
      const cleared = Promise.allSettled([matterInputState.clear(), serialize(async () => { if (operation.current === at) await clearStored(store, push) })])
      setPairing(null); setSeen(false); setEpoch(at); setTransition(false)
      const results = await cleared
      if (results.some(r => r.status === 'rejected')) throw new Error('input_storage')
    },
    forgetStale(captured = intendedPairing.current, epoch = operation.current) {
      if (captured !== intendedPairing.current || epoch !== operation.current || pairingTransition) return
      const at = ++operation.current; intendedPairing.current = null
      setPairingScope('none'); setInputScope(null)
      quietly(Promise.all([matterInputState.clear(), serialize(async () => { if (operation.current === at) await clearStored(store, push) })]), 'clear')
      setPairing(null); setSeen(false); setStale(true); setEpoch(at); setTransition(false)
    },
    staleNotice,
    seenWelcome, markWelcomeSeen: () => { setSeen(true); setStale(false) }, setSeenWelcome: setSeen,
    langOverride,
    setLangOverride(l) { setLang(l); quietly(store.savePrefs({ lang: l }), 'savePrefs') },
  }), [ready, pairing, inputScope, loadError, pairingEpoch, pairingTransition, staleNotice, seenWelcome, langOverride, store, push])
  return (
    <SessionCtx.Provider value={value}>
      <LangOverrideCtx.Provider value={langOverride}>{children}</LangOverrideCtx.Provider>
    </SessionCtx.Provider>
  )
}

export function useSession(): Session {
  const s = useContext(SessionCtx)
  if (!s) throw new Error('SessionProvider missing')
  return s
}
