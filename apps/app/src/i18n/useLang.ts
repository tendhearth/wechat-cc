import { createContext, useContext } from 'react'
import { getLocales } from 'expo-localization'
import { pickLang, type Lang } from './index'

/** 设置里手动选的语言;null = 跟随系统。由 SessionProvider 提供(偏好落钥匙串)。 */
export const LangOverrideCtx = createContext<Lang | null>(null)

export function systemLang(): Lang {
  return pickLang(getLocales().map((l) => l.languageTag))
}

export function useLang(): Lang {
  return useContext(LangOverrideCtx) ?? systemLang()
}
