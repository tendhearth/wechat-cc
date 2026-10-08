import en from './en'
import zh from './zh-Hans'

export type Lang = 'en' | 'zh-Hans'
export type MessageKey = keyof typeof en

const tables: Record<Lang, Record<MessageKey, string>> = { en, 'zh-Hans': zh }

export function pickLang(tags: readonly string[]): Lang {
  const first = tags[0]
  return first !== undefined && first.toLowerCase().startsWith('zh') ? 'zh-Hans' : 'en'
}

/** 这个键在词表里有没有(给 daemon 送来的原因码这类「可能是新码」的键用)。 */
export function hasMessage(lang: Lang, key: string): key is MessageKey {
  return typeof (tables[lang] as Record<string, unknown>)[key] === 'string'
}
export function t(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  const s = tables[lang][key]
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s
}

/** 带数量的文案:英文 n === 1 用 `<key>.one`,其余用 `<key>`;中文两条写成一样。 */
export type CountKey = 'now.waiting' | 'approval.moreLines'
export function tCount(lang: Lang, key: CountKey, n: number): string {
  return t(lang, n === 1 ? (`${key}.one` as MessageKey) : key, { n })
}

/** 「小标题：问题」:小标题以中文结尾 ⇒ 全角冒号不加空格;否则「Header: question」。 */
export function labelJoin(head: string, rest: string): string {
  return /[\u2E80-\u9FFF\uFF00-\uFFEF]$/.test(head) ? `${head}：${rest}` : `${head}: ${rest}`
}
