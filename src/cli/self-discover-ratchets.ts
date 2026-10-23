/**
 * self-discover-ratchets.ts —— `self discover` 的欠账来源之二:守卫里只许降的那些基线。
 *
 * 设计稿 2026-10-23-cc-runs-development §4.8 的「欠账」:「守卫里还在记账的基线(数字只许降的那些)」。
 * 不是每个带 BASELINE 的守卫都是欠账(speech-send 的基线是「允许在这里主动开口」的登记,不是要降到 0 的东西),
 * 所以不猜:守卫自己在那条常量上一行写 `// @debt <降到 0 意味着什么>`,这里只认带这个标记的。
 *
 * 认两种写法:`const X = 38`(一个数)和 `const BASELINE = { 'file': 2, 'file': { a: 1, b: 3 } }`(按文件,数字求和)。
 * 只读源码,不跑守卫:数字就是守卫此刻允许的上限,守卫自己保证它跟实际一致(少了也红)。
 */

export interface DebtCounter {
  /** 守卫文件(仓库里的相对路径)。 */
  guard: string
  /** `@debt` 后面那句话。 */
  what: string
  /** 现在还剩多少(数字之和)。 */
  total: number
  /** 按文件记的有几个文件;单个数字的为 null。 */
  files: number | null
}

const MARK = /^\s*\/\/\s*@debt\s+(.+)$/

export function ratchetDebts(files: Array<{ path: string; text: string }>): DebtCounter[] {
  const out: DebtCounter[] = []
  for (const f of files) {
    const lines = f.text.replace(/\r\n/g, '\n').split('\n')
    lines.forEach((line, i) => {
      const m = MARK.exec(line)
      if (!m) return
      const decl = lines[i + 1] ?? ''
      const single = /^const \w+\s*=\s*(\d+)\b/.exec(decl)
      if (single) { out.push({ guard: f.path, what: m[1]!.trim(), total: Number(single[1]), files: null }); return }
      if (!/^const \w+[^=]*=\s*\{\s*$/.test(decl)) return
      let total = 0
      let count = 0
      for (let j = i + 2; j < lines.length && !/^\}/.test(lines[j]!); j++) {
        const row = lines[j]!
        if (/^\s*\/\//.test(row)) continue
        if (/^\s*'[^']+'\s*:/.test(row)) count++
        for (const n of row.matchAll(/:\s*(\d+)\b/g)) total += Number(n[1])
      }
      out.push({ guard: f.path, what: m[1]!.trim(), total, files: count })
    })
  }
  return out.sort((a, b) => b.total - a.total)
}

export function formatRatchetDebts(debts: DebtCounter[]): string {
  const open = debts.filter(d => d.total > 0)
  if (!open.length) return '守卫里标了 @debt 的基线都已清零。'
  const out = ['守卫里只许降的欠账(数字是守卫此刻允许的上限,降一处守卫就要你把数字调下来):']
  for (const d of open) out.push(`  ${String(d.total).padStart(4)}${d.files !== null ? `(${d.files} 个文件)` : ''}  ${d.what}  — ${d.guard}`)
  return out.join('\n')
}
