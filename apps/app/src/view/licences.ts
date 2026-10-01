// 许可证原文是按 80 列硬折行的纯文本;手机上把段内的换行接成空格,让它按屏宽自己折。
// 空行、分隔线、全大写小标题、编号条款照旧另起一行。
const standalone = (l: string) => l.trim() === '' || /^-+/.test(l) || /^[A-Z0-9 ()".,&-]+$/.test(l.trim())
const startsItem = (l: string) => /^\d+\)/.test(l)

export function reflowLicence(text: string): string {
  const lines = text.split('\n')
  let out = lines[0] ?? ''
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]!, cur = lines[i]!
    out += standalone(prev) || standalone(cur) || startsItem(cur) ? `\n${cur}` : ` ${cur}`
  }
  return out
}
