import en from './en'
import zh from './zh-Hans'

export type Lang = 'en' | 'zh-Hans'
export type MessageKey = keyof typeof en

const tables: Record<Lang, Record<MessageKey, string>> = { en, 'zh-Hans': zh }

export function pickLang(tags: readonly string[]): Lang {
  const first = tags[0]
  return first !== undefined && first.toLowerCase().startsWith('zh') ? 'zh-Hans' : 'en'
}

export function t(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  const s = tables[lang][key]
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s
}
