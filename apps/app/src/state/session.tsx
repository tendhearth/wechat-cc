import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Lang } from '../i18n'
import { LangOverrideCtx } from '../i18n/useLang'

// 这一次打开 app 的界面状态:是否看过欢迎页、设置里的语言覆盖。本计划只存内存,下一份计划落盘。
type Session = {
  seenWelcome: boolean
  markWelcomeSeen(): void
  langOverride: Lang | null
  setLangOverride(l: Lang | null): void
}

const SessionCtx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [seenWelcome, setSeen] = useState(false)
  const [langOverride, setLangOverride] = useState<Lang | null>(null)
  const value = useMemo<Session>(
    () => ({ seenWelcome, markWelcomeSeen: () => setSeen(true), langOverride, setLangOverride }),
    [seenWelcome, langOverride],
  )
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
