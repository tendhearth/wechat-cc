/**
 * self-discover.ts —— `wechat-cc self discover`:从真机日志里找「反复出现的失败」,排成候选任务。
 *
 * CC 自己跑开发设计稿 §4.8「发掘任务」的第一个来源(真机信号)。主人 10-23:「不能按照预算来,而是发掘高价值任务」。
 * 这两天两路会话找活,大半就是读日志看哪类失败一直在发生(agy 两天几百次地区被拒、微信 errcode=-2 一百多次)。
 * 这里把这件事做成确定的代码:按「标签 + 去掉 id 和数字后的那句话」分组、数次数、记首次 / 最近,次数多的排前面。
 * 判断「这条值不值得修、怎么修」是规划者(模型)的事;这一层只负责把证据摆出来,不猜原因。
 *
 * 只读:只读本机日志,不联网、不调模型。
 */

export interface DiscoverInput {
  /** channel.log 的内容(老的在前)。 */
  log: string
  now: number
  /** 看最近多少小时(缺省 48)。 */
  hours: number
  /** 至少出现几次才算候选(缺省 3)。 */
  minCount: number
}

export interface Candidate {
  tag: string
  /** 去掉 id / 数字以后的那句话(分组用的键)。 */
  signature: string
  count: number
  firstSeen: string
  lastSeen: string
  /** 一条例子(截断),给规划者和人看。**抹掉了人**(聊天 id、wxid、十六进制 id、`text=` 后面的正文),数字留着 ——
   *  第 5 步会把候选交给模型(Claude / Codex)当提示词,原样的日志行里有主人和联系人的 id,偶尔还有消息原文。 */
  example: string
}

const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) \[([^\]]+)\] (.*)$/
// 「失败」的说法。宁可多收几类(排序会把偶发的压下去),别漏掉一类一直在发生的。
// 只认「发生了超时」(timed out / 等超时 / 超时了),不认裸的 timeout / 超时:开机时打印配置的那行
// 「披露闸门超时 30000ms」会被当成失败(10-23 真机第一次跑就误报了 20 次)。
const FAILURE = /\b(fail(?:ed|ure)?|error|refused|timed out|denied|gave up|not delivered|unavailable|unreachable|rejected|crash(?:ed)?)\b|失败|被拒|超时了|等超时|已超时/i

/** 抹掉一行里指向人的部分(给模型看之前必须过这一道);数字和措辞留着,不然例子就没用了。 */
export function redact(message: string): string {
  return message
    .replace(/\b[\w.+-]+@im\.wechat\b/g, '<chat>')
    .replace(/\bwxid_\w+/g, '<wxid>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b(text|body|content|msg)=.*$/i, '$1=<略>')
}

/** 把一句话里会变的部分抹掉:时间、十六进制 id、wxid、聊天 id、路径里的数字、所有数字。 */
export function signatureOf(message: string): string {
  return message
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>')
    .replace(/\b[\w.+-]+@im\.wechat\b/g, '<chat>')
    .replace(/\bwxid_\w+/g, '<wxid>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b[A-Za-z]*\d[\w-]*\b/g, m => (/^[A-Za-z]+$/.test(m) ? m : '<n>'))
    .replace(/\{[^{}]*\}/g, '{…}')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

export function discover(input: DiscoverInput): Candidate[] {
  const since = input.now - input.hours * 3_600_000
  const groups = new Map<string, Candidate>()
  for (const line of input.log.split('\n')) {
    const m = TS.exec(line)
    if (!m) continue
    const t = Date.parse(m[1]!)
    if (!(t >= since)) continue
    const [, ts, tag, msg] = m as unknown as [string, string, string, string]
    if (!FAILURE.test(msg)) continue
    const signature = signatureOf(msg)
    const key = `${tag}\u0000${signature}`
    const g = groups.get(key)
    if (g) { g.count++; g.lastSeen = ts }
    else groups.set(key, { tag, signature, count: 1, firstSeen: ts, lastSeen: ts, example: redact(msg).slice(0, 240) })
  }
  return [...groups.values()].filter(c => c.count >= input.minCount).sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
}

export function formatDiscover(cands: Candidate[], hours: number): string {
  if (!cands.length) return `最近 ${hours} 小时日志里没有反复出现的失败。`
  const out = [`最近 ${hours} 小时反复出现的失败(${cands.length} 类,次数多的在前):`]
  for (const c of cands.slice(0, 20)) {
    out.push(`  ${String(c.count).padStart(4)} 次  [${c.tag}] ${c.signature}`)
    out.push(`         ${c.firstSeen.slice(5, 16)} → ${c.lastSeen.slice(5, 16)}  例:${c.example.slice(0, 120)}`)
  }
  return out.join('\n')
}
