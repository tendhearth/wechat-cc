/**
 * 手机「洞察」(批准说明、进展概括)共用的便宜模型小工具(spec 2026-09-30-tendhearth-app-v1 §5)。
 * 便宜模型的输出只是说明,永远有原文兜底;这里只管:带预算调用、从回复里抽 JSON、语言归一、判断词识别。
 */
import type { CheapEval } from '../core/agent-provider'

export type InsightLang = 'en' | 'zh-Hans'

export function normalizeLang(raw: string | null | undefined): InsightLang {
  return raw === 'zh-Hans' ? 'zh-Hans' : 'en'
}

export async function runCheap(cheapEval: CheapEval, prompt: string, budgetMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      cheapEval(prompt),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('insight_timeout')), budgetMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 第一个平衡的 {...};字符串里的括号不算。 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        const v: unknown = JSON.parse(raw.slice(start, i + 1))
        return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
      } catch { return null }
    }
  }
  return null
}

/**
 * 说明里不许出现替用户下判断的词 —— 命令描述里的注入最想骗出的就是这些。
 * 这只是礼貌性过滤,不是安全边界:App 永远会原样展示原始命令。
 */
export const JUDGEMENT_WORDS = /安全|放心|无风险|没问题|建议(你)?(允许|批准|同意)|可以批准|推荐|无害|\bsafe(ly|ty)?\b|harmless|benign|innocuous|risk-free|no risk|fine to|recommend|should (allow|approve)/i

/** 先 NFKC 归一(全角 ｓａｆｅ 等)再判断。 */
export function hasJudgement(s: string): boolean {
  return JUDGEMENT_WORDS.test(s) || JUDGEMENT_WORDS.test(s.normalize('NFKC'))
}

export const clipChars = (s: string, n: number): string => {
  const cs = [...s.replace(/\s+/g, ' ').trim()]
  return cs.length > n ? cs.slice(0, n - 1).join('') + '…' : cs.join('')
}
