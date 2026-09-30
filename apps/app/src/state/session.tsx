import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Lang } from '../i18n'
import { LangOverrideCtx } from '../i18n/useLang'
import type { CredentialStore } from '../net/credentials'
import type { PairingRecord } from '../net/pairing'

// 会话:配对记录与语言偏好落钥匙串;「已看过欢迎页」= 已配对,或这次打开点过「先看看」。
type Session = {
  ready: boolean
  pairing: PairingRecord | null
  setPaired(r: PairingRecord): Promise<void>
  /** 被电脑撤销:只清钥匙串;内存里的配对留着,后端停在 revoked,页面显示最后同步的内容 + 重新配对。 */
  dropStoredPairing(): void
  /** 用户解除配对:钥匙串与内存都清,回欢迎页。 */
  forgetPairing(): Promise<void>
  seenWelcome: boolean
  markWelcomeSeen(): void
  setSeenWelcome(v: boolean): void
  langOverride: Lang | null
  setLangOverride(l: Lang | null): void
}

const SessionCtx = createContext<Session | null>(null)

export function SessionProvider({ children, store }: { children: ReactNode; store: CredentialStore }) {
  const [ready, setReady] = useState(false)
  const [pairing, setPairing] = useState<PairingRecord | null>(null)
  const [seenWelcome, setSeen] = useState(false)
  const [langOverride, setLang] = useState<Lang | null>(null)
  useEffect(() => {
    let alive = true
    Promise.all([store.load(), store.loadPrefs()]).then(
      ([p, prefs]) => { if (!alive) return; setPairing(p); setSeen(p !== null); setLang(prefs.lang); setReady(true) },
      () => { if (alive) setReady(true) }, // 钥匙串读不出来 ⇒ 当没配对
    )
    return () => { alive = false }
  }, [store])
  const value = useMemo<Session>(() => ({
    ready, pairing,
    async setPaired(r) { await store.save(r); setPairing(r); setSeen(true) },
    dropStoredPairing() { void store.clear() },
    async forgetPairing() { await store.clear(); setPairing(null); setSeen(false) },
    seenWelcome, markWelcomeSeen: () => setSeen(true), setSeenWelcome: setSeen,
    langOverride,
    setLangOverride(l) { setLang(l); void store.savePrefs({ lang: l }) },
  }), [ready, pairing, seenWelcome, langOverride, store])
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
