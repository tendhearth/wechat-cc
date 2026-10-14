/** 把一条结果切成「命中 / 不命中」几段,给阅读视图上底色(不改字色、不加粗:一个强调色只给动作)。 */
export function searchSegments(text: string, q: string): Array<{ text: string; hit: boolean }> {
  const needle = q.trim()
  if (!needle) return [{ text, hit: false }]
  const out: Array<{ text: string; hit: boolean }> = []
  let at = 0
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
    if (i > at) out.push({ text: text.slice(at, i), hit: false })
    out.push({ text: needle, hit: true })
    at = i + needle.length
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out
}
