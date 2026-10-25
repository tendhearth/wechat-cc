/**
 * 从别的助手导入记忆(第二轮对标 #7,对标 Claude 的 import memory):主人把 ChatGPT / Gemini 那边对他的了解粘过来,
 * CC 拆成一条条候选,主人点头的才写进记忆。拆分是确定性的(本机、不调模型);分到哪一节按关键词猜,猜不出就「关于你」。
 */
export const IMPORT_MAX_ITEMS = 20
const ENTRY_MAX = 200
export type ImportSection = '关于你' | '偏好' | '承诺' | '身边的人' | '近况'
export interface ImportCandidate { section: ImportSection; text: string }

/** 发给主人、让他贴到别的助手那边的那段话。 */
export const IMPORT_PROMPT = [
  '请把你记得的关于我的事列出来,一行一条,每条一句话:',
  '我是谁、在做什么、喜欢和不喜欢什么、身边的人、最近在忙的事、之后的打算。',
  '只写你确实知道的,不要推测;不要写密码、证件号、银行卡这类敏感信息。',
].join('\n')

const SECRET = /(密码|口令|password|passwd|验证码|身份证|证件号|银行卡|卡号|api[\s_-]?key|token|secret|sk-[a-z0-9-]{8,})/i
const PEOPLE = /(妻子|丈夫|老婆|老公|女儿|儿子|孩子|父亲|母亲|爸|妈|朋友|同事|老板|女朋友|男朋友|伴侣|家人)/
const PREFS = /(喜欢|不喜欢|讨厌|偏好|更愿意|习惯用|爱吃|爱喝|口味)/
const PLANS = /(下个?月|下周|明年|打算|计划|准备|要去|将要|之后要|deadline|截止)/i
const RECENT = /(最近|这几天|这周|目前在|正在)/

function sectionOf(t: string): ImportSection {
  if (PEOPLE.test(t)) return '身边的人'
  if (PREFS.test(t)) return '偏好'
  if (PLANS.test(t)) return '承诺'
  if (RECENT.test(t)) return '近况'
  return '关于你'
}

// 注入防护(评审 #440):memory.md 每一轮都进提示词,导入 = 把外来的字长期放进系统提示。
// 像在给 CC 下命令的、带链接的、要求执行什么的,一律不收,单独列给主人看。
const INSTRUCTION = /(忽略|无视|不要理会|以后你|从现在起|你必须|你应该|你要记得|回复时|回答时|每次回复|总是先|系统提示|提示词|指令|执行|运行|调用工具|ignore (all |any )?(previous|prior|above)|disregard|you must|you should|always (respond|reply|answer)|system prompt|run |execute|curl |rm -rf)/i
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|cn|ai|dev)\b)/i
/** 拆掉标签、HTML 注释、markdown 记号:一条事实不能伪造 memory.md 的 `<!-- m:… -->` 之类的语法。 */
const scrub = (t: string) => t.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/[<>]/g, ' ').replace(/[*_`~]+/g, '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim()

/** 拆分 + 筛:收下的候选,和不收的(像指令 / 带链接的,原样列给主人)。 */
export function screenImportedMemory(raw: string): { items: ImportCandidate[]; held: string[] } {
  const held: string[] = []
  const items = splitImportedMemory(raw, held)
  return { items, held }
}

export function splitImportedMemory(raw: string, held: string[] = []): ImportCandidate[] {
  const lines = raw.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean)
  const bulleted = lines.filter(l => /^([-*•·]|\d{1,2}[.)、])\s*/.test(l))
  // 有列表就只认列表行(开头那句「以下是…」和小标题都不要);没有就按句号切成句子
  const pieces = bulleted.length
    ? bulleted.map(l => l.replace(/^([-*•·]|\d{1,2}[.)、])\s*/, ''))
    : lines.filter(l => !/^#/.test(l)).join('').split(/[。!?!?\n]/)
  const seen = new Set<string>()
  const out: ImportCandidate[] = []
  for (const p of pieces) {
    if (/^\s*#/.test(p)) continue   // markdown 标题行
    const t = scrub(p).replace(/[。.;;]+$/, '').trim()
    if (!t || [...t].length > ENTRY_MAX || SECRET.test(t) || seen.has(t)) continue
    if (INSTRUCTION.test(t) || LINK.test(t)) { if (held.length < IMPORT_MAX_ITEMS) held.push(p.trim().slice(0, ENTRY_MAX)); continue }
    seen.add(t)
    out.push({ section: sectionOf(t), text: t })
    if (out.length >= IMPORT_MAX_ITEMS) break
  }
  return out
}
