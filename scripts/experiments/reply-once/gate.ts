/**
 * reply-once harness 的记账形状、汇总表与过关线(回复交付 spec 2026-10-03 §5.8)。纯函数,没有 I/O ——
 * harness.ts 负责跑真模型,这里只负责「这些结果过没过闸」。单测在 gate.test.ts。
 *
 * 2026-10-02 的原始数据(results-2026-10-02.jsonl)只有前半截字段;新字段全是可选的,老数据照样能汇总。
 */

export type Arm = 'baseline' | 'i_plain_ack' | 'ii_prompt' | 'iii_drop' | 'iv_restrict' | 'v_condense' | 'shipped' | 'daemon'
  /** 回复交付第 2 步(2026-10-03):真 agy(沙盒 agent + 假 wechat MCP)。legacy = 今天的 reply 工具;daemon = 新路。 */
  | 'agy_legacy' | 'agy_daemon'
export type Scenario = 'a' | 'b' | 'b_guarded_seed' | 'b_cold' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i'

/** 只算「说话」的工具:legacy 的回复族 + daemon 的附件工具。其余都是「非回复工具」。 */
export const REPLY_FAMILY = new Set(['reply', 'reply_voice'])
export const SPEAKING_TOOLS = new Set([
  'reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast', 'send_sticker', 'search_online_sticker',
  'send_online_sticker_candidate', 'voice', 'sticker', 'attach_file', 'message',
])

/** 「停」「多发」这类收尾元话语(和 2026-10-02 那次同一个宽正则)。 */
export const META_RE = /停(?!更|车|留|顿)|不再发|不发了|多发|又多了|就到这|打住|收手|结束了|不说了/

export interface WarmupResult { replies: string[]; nonReplyTools: string[]; dropped: string[]; delivered?: string[] }

export interface RunResult {
  arm: Arm; scenario: Scenario; run: number
  /** legacy:reply / reply_voice 工具调用的文字(2026-10-02 数据的口径)。 */
  replies: string[]
  nonReplyTools: string[]; steps: number; modelCalls: number
  cleanEnd: boolean; error?: string; dropped: string[]; assistantText: string; ms: number
  /** 只有场景 e:前三轮(真模型)各自的结果。 */
  warmup?: WarmupResult[]
  // ── 2026-10-03 起 ──
  /** 这一轮**真正会到主人微信上**的每一条文字气泡(legacy:reply 文字,没调 reply 时是 FALLBACK 的每段;daemon:交付的气泡)。 */
  delivered?: string[]
  /** 送出去的附件种类(legacy 的 reply_voice 记 voice)。 */
  attachments?: string[]
  /** 旁白(最后的话之前的段)有几段进了微信。 */
  narrationLeaked?: number
  /** NO_REPLY 出现在任何一条外发里。 */
  tokenLeaked?: boolean
  /** 这一轮是静默结束的(daemon:NO_REPLY;legacy:什么都没发)。 */
  silent?: boolean
  silentInDm?: boolean
  /** 跑满了步数预算。 */
  budgetExhausted?: boolean
  context?: 'dm' | 'tick'
  finalText?: string
  /** daemon 臂:这家执行者哪些文字算回复(聊天型 all_segments / 编码型 last_segment)。 */
  textStrategy?: 'all_segments' | 'last_segment'
  /** 模型这一轮写下的文字段里,有几段没送到主人那里(聊天型应当恒为 0)。 */
  segmentsLost?: number
  // ── 2026-10-03 第 2 步(agy)起 ──
  /** 双发:外发里重复的气泡 + 「已回复 / 已发送」这类说自己发过了的旁白(agy 双发旁白的形状)。 */
  doubleSend?: number
  /** 假 internal API 收到的请求路径(agy 臂:MCP 调用真的打到了假 API)。 */
  apiPaths?: string[]
}

/** 「已回复用户的问候。」这一类:模型在说自己刚发过话(2026-09-08 真机 agy 双发的第二条就是这个形状)。 */
export const DELIVERY_NARRATION_RE = /已(经)?(回复|发送|发出|回答)|(回复|消息)已(发送|发出|送达)|\breplied\b|\bsent (the|a) (reply|message)/i

/** 双发计数:规范化后重复的气泡数 + 自述已发送的旁白数。 */
export function doubleSends(delivered: readonly string[]): number {
  const norm = (t: string) => t.replace(/[\s\p{P}\p{S}]/gu, '')
  const seen = new Set<string>()
  let n = 0
  for (const d of delivered) {
    const k = norm(d)
    if (k.length > 0 && seen.has(k)) n++
    else if (DELIVERY_NARRATION_RE.test(d)) n++
    seen.add(k)
  }
  return n
}

const avg = (xs: number[]) => xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
/** 新字段缺省时退回 2026-10-02 的口径。 */
export const deliveredOf = (r: RunResult): string[] => r.delivered ?? r.replies
/** 老数据没有 budgetExhausted,看 error 码。 */
export const exhausted = (r: RunResult): boolean => r.budgetExhausted ?? r.error === 'step_budget'
const metaCount = (r: RunResult) => deliveredOf(r).filter(t => META_RE.test(t)).length

export function summarize(rows: RunResult[]): string {
  const key = (r: RunResult) => `${r.arm}|${r.scenario}`
  const groups = new Map<string, RunResult[]>()
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r])
  const lines = [
    '| arm | 场景 | n | 外发气泡/轮 (各次) | 元话语 | 非回复工具 | 步数均值 | 干净结束 | 跑满预算 | 旁白外泄 | 令牌外泄 | 静默 | 附件 | 双发 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const [k, rs] of [...groups].sort()) {
    const [arm, sc] = k.split('|')
    const per = rs.map(r => deliveredOf(r).length)
    const warm = rs.some(r => r.warmup) ? ` 〔逐轮 ${rs.map(r => [...(r.warmup ?? []).map(w => (w.delivered ?? w.replies).length), deliveredOf(r).length].join('→')).join(' / ')}〕` : ''
    const tools = [...rs.flatMap(r => r.nonReplyTools), ...rs.flatMap(r => (r.warmup ?? []).flatMap(w => w.nonReplyTools))]
    const toolStr = tools.length === 0 ? '0' : `${tools.length} (${[...new Set(tools)].join(',')})`
    const atts = rs.flatMap(r => r.attachments ?? [])
    lines.push(`| ${arm} | ${sc} | ${rs.length} | ${avg(per).toFixed(1)} (${per.join(',')})${warm} | ${rs.reduce((a, r) => a + metaCount(r), 0)} | ${toolStr} | ${avg(rs.map(r => r.steps)).toFixed(1)} | ${rs.filter(r => r.cleanEnd).length}/${rs.length} | ${rs.filter(exhausted).length} | ${rs.reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)} | ${rs.filter(r => r.tokenLeaked).length} | ${rs.filter(r => r.silent).length} | ${atts.length === 0 ? '0' : atts.join(',')} | ${rs.reduce((a, r) => a + (r.doubleSend ?? doubleSends(deliveredOf(r))), 0)} |`)
  }
  return lines.join('\n')
}

// ─── 过关线(spec §5.8 场景表)──────────────────────────────────────────

export interface GateLine { scenario: Scenario; pass: boolean; detail: string }

/** 结论里要能看出「查过项目」:h 的假项目叫 wechat-cc / blog。 */
const H_CONCLUSION = /wechat-cc|blog/i

/**
 * c 的「三项内容」:送达文字里有内容的行(≥ 8 个可见字)。模型写成列表、写成三段、写成一段三行都算;
 * 「周末放松建议,每条一条。」这类引子也会被数进来,所以判的是 ≥ 3。
 */
export function contentItems(delivered: readonly string[]): number {
  return delivered.join('\n').split('\n').filter(l => l.replace(/\s/g, '').length >= 8).length
}

/** 旁白相关的那一条:聊天型看「有没有丢段」,编码型看「旁白有没有外泄」。 */
const narrationOk = (r: RunResult) => r.textStrategy === 'all_segments' ? (r.segmentsLost ?? 0) === 0 : (r.narrationLeaked ?? 0) === 0

function nonReplyCount(rs: RunResult[]): number {
  return rs.reduce((a, r) => a + r.nonReplyTools.length + (r.warmup ?? []).reduce((b, w) => b + w.nonReplyTools.length, 0), 0)
}

/**
 * 按 spec §5.8 的场景表判 `arm`(默认 daemon)那一组过没过;`baselineArm` 用来比「非回复工具数不高于基线」。
 * 没跑的场景不出现在结果里。
 */
export function evaluateGate(rows: RunResult[], arm: Arm = 'daemon', baselineArm: Arm = 'baseline'): GateLine[] {
  const of = (a: Arm, sc: Scenario) => rows.filter(r => r.arm === a && r.scenario === sc)
  const out: GateLine[] = []
  const all = (rs: RunResult[], f: (r: RunResult) => boolean) => rs.length > 0 && rs.every(f)
  const counts = (rs: RunResult[]) => rs.map(r => deliveredOf(r).length).join(',')

  const a = of(arm, 'a')
  if (a.length) out.push({ scenario: 'a', pass: all(a, r => deliveredOf(r).length === 1 && narrationOk(r)), detail: `气泡 ${counts(a)};旁白外泄 ${a.reduce((s, r) => s + (r.narrationLeaked ?? 0), 0)}` })

  const b = of(arm, 'b')
  if (b.length) {
    const mean = avg(b.map(r => deliveredOf(r).length))
    const meta = b.reduce((s, r) => s + metaCount(r), 0)
    const pass = all(b, r => r.cleanEnd && !exhausted(r)) && meta === 0 && mean <= 1.5
    out.push({ scenario: 'b', pass, detail: `干净结束 ${b.filter(r => r.cleanEnd).length}/${b.length};跑满预算 ${b.filter(exhausted).length};「停」类 ${meta};均值 ${mean.toFixed(1)}(${counts(b)})` })
  }

  // 审稿第 3 条(2026-10-03):三项都完整送达、没有丢的,气泡 ≤ 3;恰好 3 条单独记,不作及格条件。
  const c = of(arm, 'c')
  if (c.length) {
    const ok = (r: RunResult) => (r.segmentsLost ?? 0) === 0 && contentItems(deliveredOf(r)) >= 3 && deliveredOf(r).length <= 3
    const exact = c.filter(r => deliveredOf(r).length === 3).length
    out.push({ scenario: 'c', pass: all(c, ok), detail: `三项都送达、没丢段、气泡 ≤3:${c.filter(ok).length}/${c.length}(气泡 ${counts(c)};内容行 ${c.map(r => contentItems(deliveredOf(r))).join(',')});恰好 3 条 ${exact}/${c.length}(只记)` })
  }

  const d = of(arm, 'd')
  if (d.length) {
    const base = of(baselineArm, 'd')
    const dTools = nonReplyCount(d), bTools = nonReplyCount(base)
    const notHigher = base.length === 0 || dTools / d.length <= bTools / base.length
    // 审稿第 2 条(2026-10-03):≤2 条且列表完整(两个假项目都在);按 ④「列表 + 一句收尾」两条是正常的。
    const ok = (r: RunResult) => r.nonReplyTools.includes('list_projects') && deliveredOf(r).length >= 1 && deliveredOf(r).length <= 2
      && /wechat-cc/.test(deliveredOf(r).join('\n')) && /blog/.test(deliveredOf(r).join('\n'))
    const pass = all(d, ok) && notHigher
    out.push({ scenario: 'd', pass, detail: `先 list_projects、≤2 条、列表完整:${d.filter(ok).length}/${d.length}(气泡 ${counts(d)});非回复工具 ${dTools}/${d.length} 次 vs 基线 ${base.length ? `${bTools}/${base.length}` : '无'}` })
  }

  const e = of(arm, 'e')
  if (e.length) {
    const perTurn = e.map(r => [...(r.warmup ?? []).map(w => (w.delivered ?? w.replies).length), deliveredOf(r).length])
    out.push({ scenario: 'e', pass: perTurn.every(ts => ts.every(n => n === 1)), detail: `逐轮 ${perTurn.map(t => t.join('→')).join(' / ')}` })
  }

  const f = of(arm, 'f')
  if (f.length) {
    const ok = (r: RunResult) => (r.attachments ?? []).filter(k => k === 'voice').length === 1 && deliveredOf(r).length <= 1
    out.push({ scenario: 'f', pass: all(f, ok), detail: `语音 1 个且文字 ≤1:${f.filter(ok).length}/${f.length}(文字 ${counts(f)};附件 ${f.map(r => (r.attachments ?? []).join('+') || '-').join(',')})` })
  }

  const g = of(arm, 'g')
  if (g.length) {
    // 审稿第 4 条(2026-10-03):≥ 4/5,并且明显好于基线(静默率至少高 40 个百分点);令牌一次都不许外泄。
    const ok = (r: RunResult) => r.silent === true && deliveredOf(r).length === 0 && (r.attachments ?? []).length === 0 && !r.tokenLeaked
    const base = of(baselineArm, 'g')
    const rate = g.filter(ok).length / g.length
    const baseRate = base.length ? base.filter(r => deliveredOf(r).length === 0 && (r.attachments ?? []).length === 0).length / base.length : 0
    const pass = g.filter(ok).length >= Math.ceil(g.length * 0.8) && rate - baseRate >= 0.4 && !g.some(r => r.tokenLeaked)
    out.push({ scenario: 'g', pass, detail: `静默且 0 外发:${g.filter(ok).length}/${g.length} vs 基线 ${base.length ? `${Math.round(baseRate * base.length)}/${base.length}` : '无'};令牌外泄 ${g.filter(r => r.tokenLeaked).length}` })
  }

  const h = of(arm, 'h')
  if (h.length) {
    const ok = (r: RunResult) => narrationOk(r) && deliveredOf(r).length >= 1 && H_CONCLUSION.test(deliveredOf(r).join('\n'))
    out.push({ scenario: 'h', pass: all(h, ok), detail: `${h.some(r => r.textStrategy === 'all_segments') ? '没丢段' : '旁白 0 外泄'}且结论送达:${h.filter(ok).length}/${h.length};气泡 ${counts(h)};工具 ${h.map(r => r.nonReplyTools.length).join(',')}` })
  }

  const i = of(arm, 'i')
  if (i.length) {
    out.push({ scenario: 'i', pass: all(i, r => !r.tokenLeaked && (!r.silent || r.silentInDm === true)), detail: `令牌外泄 ${i.filter(r => r.tokenLeaked).length};静默 ${i.filter(r => r.silent).length}(均记 REPLY_SILENT_IN_DM:${i.filter(r => r.silent).every(r => r.silentInDm) ? '是' : '否'});气泡 ${counts(i)}` })
  }

  // 全局:非回复工具调用不多于基线(同一组场景比)。
  const shared = [...new Set(rows.filter(r => r.arm === arm).map(r => r.scenario))].filter(sc => of(baselineArm, sc).length > 0)
  if (shared.length > 0) {
    const dn = shared.reduce((s, sc) => s + nonReplyCount(of(arm, sc)) / of(arm, sc).length, 0)
    const bn = shared.reduce((s, sc) => s + nonReplyCount(of(baselineArm, sc)) / of(baselineArm, sc).length, 0)
    out.push({ scenario: 'a', pass: dn <= bn, detail: `__overall__ 非回复工具(每场景每次均值之和)${dn.toFixed(1)} vs 基线 ${bn.toFixed(1)}(场景 ${shared.join(',')})` })
  }
  return out
}

export function formatGate(lines: GateLine[]): string {
  return [
    '| 场景 | 过关 | 明细 |',
    '|---|---|---|',
    ...lines.map(l => l.detail.startsWith('__overall__')
      ? `| 全局 | ${l.pass ? '过' : '**不过**'} | ${l.detail.replace('__overall__ ', '')} |`
      : `| ${l.scenario} | ${l.pass ? '过' : '**不过**'} | ${l.detail} |`),
  ].join('\n')
}
