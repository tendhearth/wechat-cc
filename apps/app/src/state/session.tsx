import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
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
  inputScope: string | null
  pairing: PairingRecord | null
  setPaired(r: PairingRecord): Promise<void>
  /** 被电脑撤销:只清钥匙串(配对记录 + 推送密钥);内存里的配对留着,后端停在 revoked,页面显示最后同步的内容 + 重新配对。 */
  dropStoredPairing(): void
  /** 用户解除配对:钥匙串(配对记录 + 推送密钥)与内存都清,回欢迎页。 */
  forgetPairing(): Promise<void>
  /** 启动核验发现配对已失效(恢复回来的旧记录,D8):清钥匙串与内存,回欢迎页并说明。 */
  forgetStale(): void
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
  useEffect(() => {
    let alive = true
    if (inputs) matterInputState.configure(inputs)
    // loadSession 不会拒绝:配对与偏好各读各的,读不出来的那样当空
    void loadSession(store).then(async ({ pairing: p, lang }) => {
      // Restoring the Keychain journal finishes before routes mount. Failure is visible and sends stay locked.
      try { await matterInputState.activate(p) } catch { /* recovery state supplies the notice/retry */ }
      if (!alive) return
      const scope = matterInputState.recovery().scope
      setInputScope(scope); setPairingScope(scope ?? 'none')
      setPairing(p); setSeen(p !== null); setLang(lang); setReady(true)
    })
    return () => { alive = false }
  }, [store, inputs])
  const value = useMemo<Session>(() => ({
    ready, pairing, inputScope,
    async setPaired(r) {
      matterInputState.suspend()
      try { await store.save(r) } catch (e) { try { await matterInputState.activate(pairing) } catch {} throw e }
      const reset = matterInputState.activate(r, false)
      try { await reset } catch { /* Pairing may succeed while journal cleanup still needs retry. */ }
      const scope = matterInputState.recovery().scope
      setPairingScope(scope ?? 'none'); setInputScope(scope); setPairing(r); setSeen(true); setStale(false)
    },
    dropStoredPairing() { setPairingScope('revoked'); setInputScope(null); quietly(Promise.all([matterInputState.clear(), clearStored(store, push)]), 'clear') },
    async forgetPairing() {
      setPairingScope('none'); setInputScope(null)
      const cleared = Promise.allSettled([matterInputState.clear(), clearStored(store, push)])
      setPairing(null); setSeen(false)
      const results = await cleared
      if (results.some(r => r.status === 'rejected')) throw new Error('input_storage')
    },
    forgetStale() { setPairingScope('none'); setInputScope(null); quietly(Promise.all([matterInputState.clear(), clearStored(store, push)]), 'clear'); setPairing(null); setSeen(false); setStale(true) },
    staleNotice,
    seenWelcome, markWelcomeSeen: () => { setSeen(true); setStale(false) }, setSeenWelcome: setSeen,
    langOverride,
    setLangOverride(l) { setLang(l); quietly(store.savePrefs({ lang: l }), 'savePrefs') },
  }), [ready, pairing, inputScope, staleNotice, seenWelcome, langOverride, store, push])
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
