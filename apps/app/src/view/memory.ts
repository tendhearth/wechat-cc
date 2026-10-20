// 「CC 记得你」一条记忆的出处(2026-10-21):从别的助手导入的(#440,sources[].kind === 'import')点开显示「从 X 导入」。
// daemon 存的 excerpt 就是「从 X 导入」;拆不出 X ⇒「从别的助手导入」。kind 开放(string),别的类这里不画。纯 TS。
import { t, type Lang } from '../i18n'

type Source = { ts: string; excerpt: string; kind?: string }

export function memoryImportLine(sources: readonly Source[] | undefined, lang: Lang): string | null {
  const src = sources?.find(s => s.kind === 'import')
  if (!src) return null
  const x = /^从\s*(.+?)\s*导入$/.exec(src.excerpt.trim())?.[1]?.trim()
  return x ? t(lang, 'memory.importedFrom', { x }) : t(lang, 'memory.importedOther')
}
