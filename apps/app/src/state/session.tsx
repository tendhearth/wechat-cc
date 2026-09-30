import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Lang } from '../i18n'
import { LangOverrideCtx } from '../i18n/useLang'
import type { CredentialStore } from '../net/credentials'
import type { PairingRecord } from '../net/pairing'
import { clearStored, loadSession, quietly } from './session-store'

// 会话:配对记录与语言偏好落钥匙串;「已看过欢迎页」= 已配对,或这次打开点过「先看看」。
type Session = {
  ready: boolean
  pairing: PairingRecord | null
  setPaired(r: PairingRecord): Promise<void>
  /** 被电脑撤销:只清钥匙串(配对记录 + 推送密钥);内存里的配对留着,后端停在 revoked,页面显示最后同步的内容 + 重新配对。 */
  dropStoredPairing(): void
  /** 用户解除配对:钥匙串(配对记录 + 推送密钥)与内存都清,回欢迎页。 */
  forgetPairing(): Promise<void>
  seenWelcome: boolean
  markWelcomeSeen(): void
  setSeenWelcome(v: boolean): void
  langOverride: Lang | null
  setLangOverride(l: Lang | null): void
}

const SessionCtx = createContext<Session | null>(null)

/** push:撤销 / 解除配对时一起清推送密钥(并注销本机推送)的那一方;失败只记一行,不连累配对的清除。 */
export function SessionProvider({ children, store, push }: { children: ReactNode; store: CredentialStore; push: { clear(): Promise<void> } }) {
  const [ready, setReady] = useState(false)
  const [pairing, setPairing] = useState<PairingRecord | null>(null)
  const [seenWelcome, setSeen] = useState(false)
  const [langOverride, setLang] = useState<Lang | null>(null)
  useEffect(() => {
    let alive = true
    // loadSession 不会拒绝:配对与偏好各读各的,读不出来的那样当空
    void loadSession(store).then(({ pairing: p, lang }) => {
      if (!alive) return
      setPairing(p); setSeen(p !== null); setLang(lang); setReady(true)
    })
    return () => { alive = false }
  }, [store])
  const value = useMemo<Session>(() => ({
    ready, pairing,
    async setPaired(r) { await store.save(r); setPairing(r); setSeen(true) },
    dropStoredPairing() { quietly(clearStored(store, push), 'clear') },
    async forgetPairing() { await clearStored(store, push); setPairing(null); setSeen(false) },
    seenWelcome, markWelcomeSeen: () => setSeen(true), setSeenWelcome: setSeen,
    langOverride,
    setLangOverride(l) { setLang(l); quietly(store.savePrefs({ lang: l }), 'savePrefs') },
  }), [ready, pairing, seenWelcome, langOverride, store, push])
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
