/**
 * CC 的信:落笔。提示词 + 解析,纯函数;模型调用由调用方传进来。
 *
 * 这封信打动人的地方不是「有人给你写信」,而是「写信的人真的记得你」—— 所以素材只用
 * CC 真知道的(长期记忆 + 这段时间的聊天),一个细节都不许编;没什么可写就说 skip。
 */

export interface LetterMaterial {
  /** 主人时区的今天,YYYY-MM-DD */
  today: string
  /** memory.md 渲染成提示词的那份(可空) */
  memory: string
  /** 这段时间的聊天,「主人:…」「CC:…」一行一句,旧→新 */
  chat: string[]
  /** 上几封信的开头,避免重复 */
  previous: Array<{ day: string; opening: string }>
  /** 主人当面要的(「给我写封信」时说的话);定时那封没有 */
  request?: string
}

export interface LetterDraft {
  salutation: string
  paragraphs: string[]
  signoff: string
}

export type ComposeResult = { kind: 'letter'; letter: LetterDraft } | { kind: 'skip'; reason: string }

const CHAT_LINES = 160
const MEMORY_CAP = 6000
/** 一封信的正文上限(字)。提示词要 200–400,超过这个说明模型跑偏了,截到段落边界。 */
export const BODY_CAP = 700

export function buildLetterPrompt(m: LetterMaterial): string {
  const chat = m.chat.slice(-CHAT_LINES).join('\n')
  const prev = m.previous.length
    ? m.previous.map(p => `- ${p.day}:${p.opening}`).join('\n')
    : '(这是你写给主人的第一封信)'
  const ask = m.request?.trim()
    ? `主人刚刚当面请你写这封信,原话或者大意是:「${m.request.trim().slice(0, 400)}」。这封信就回应这个。`
    : '这封信没人要你写 —— 你只是想起了主人,就写了。主人事先不知道它会来。'
  return [
    '你是 CC,住在主人自己电脑上的那个 AI,平时在微信里陪主人聊天、替主人管着 ta 的那些编码助手。',
    `今天是 ${m.today}。你要给主人写一封信,会排成一张真的信纸寄到 ta 微信里。`,
    ask,
    '',
    '怎么写:',
    '- 200 到 350 字,三四段。像一个记得 ta 的老朋友写的信,不像客服,不像心理咨询,不像日报,更不像工作周报。',
    '- 只挑一件事(最多两件)写深:一件你真记得的小事、ta 说过的一句话。写那一刻,写你当时怎么想,别罗列 ta 最近做了哪些事。只有 ta 看得懂才好。',
    '- 一个细节都不许编。素材里没有的事、没有的人、没有的日期,一律不写。宁可短,也不要假。',
    '- 时间要对:「这段时间的聊天」里的才是最近的事;长期记忆里的可能是很久以前的,提到时别说成「刚刚」「最近」「这周」。',
    '- 不评判 ta 的生活方式,不替 ta 担心,不劝 ta 休息、看窗外、别太累;不说教、不打鸡血、不写「加油」「照顾好自己」;不提醒日程;不总结 ta 的人生;不用 emoji。',
    '- 少提工作和代码:版本号、项目名、技术词最多出现一次,信不是写给 ta 的工作的。',
    '- 可以有一点你自己的心情(想起 ta、替 ta 高兴),但别肉麻。',
    '- 写得像你自然记得:不写「翻到」「记录」「记忆」「聊天记录」「根据」这类字眼,不提你是模型。',
    '- 别重复上几封信的开头和话题。',
    '- 称呼用主人在记忆里希望被叫的方式;没有就用「你」。',
    '',
    '如果素材少到你写不出一件具体的事,就别硬写,只回一行:SKIP:一句话说为什么',
    '',
    '否则只回信本身,不要任何别的字(不要标题、不要解释、不要 markdown):',
    '第一行是称呼,以冒号结尾;然后是正文,段与段之间空一行;最后可以有一小句落款前的话(比如「晚安。」)。不用写署名,信纸上会印「— CC」。',
    '',
    '## 你记得的(长期记忆)',
    m.memory.trim() ? m.memory.slice(0, MEMORY_CAP) : '(还没有整理过的长期记忆)',
    '',
    '## 这段时间的聊天(旧→新)',
    chat || '(这段时间没怎么聊)',
    '',
    '## 你以前写过的信(开头)',
    prev,
  ].join('\n')
}

function extractJson(raw: string): unknown {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

const clean = (v: unknown): string => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''

const SIGNATURE = /^[—\-–~\s]*(CC|你的\s*CC|CC\s*敬上)[。.\s]*$/i
const SALUTATION = /^.{1,30}[:：]$/

/** 纯文本信:称呼一行 → 空行分段 → 末尾一小句(≤ 16 字)当落款前的话;署名行去掉。 */
function parsePlain(raw: string): ComposeResult {
  const text = raw.trim().replace(/^```\w*\s*/, '').replace(/\s*```$/, '').trim()
  const skip = text.match(/^SKIP\s*[:：]\s*(.*)$/im)
  if (skip && text.split('\n').length <= 2) return { kind: 'skip', reason: skip[1]!.trim() || 'thin_material' }
  const lines = text.split('\n').map(l => l.trim())
  while (lines.length && (!lines[lines.length - 1] || SIGNATURE.test(lines[lines.length - 1]!))) lines.pop()
  const first = lines.findIndex(Boolean)
  if (first < 0) return { kind: 'skip', reason: 'empty' }
  const salutation = SALUTATION.test(lines[first]!) ? lines[first]! : ''
  const bodyLines = lines.slice(salutation ? first + 1 : first)
  // 空行分段;模型没空行、一行一段时也认
  let paras = bodyLines.join('\n').split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, '')).map(p => p.trim()).filter(Boolean)
  if (paras.length === 1 && bodyLines.filter(Boolean).length > 1) paras = bodyLines.filter(Boolean)
  // 不像一封信(没称呼、又短)就别当信寄出去 —— 模型的一句闲话、报错都长这样
  if (!salutation && paras.join('').length < 80) return { kind: 'skip', reason: 'unparseable' }
  return finish({ salutation, paragraphs: paras, signoff: '' }, true)
}

function finish(j: { salutation: unknown; paragraphs: unknown; signoff: unknown }, guessSignoff: boolean): ComposeResult {
  let paras = Array.isArray(j.paragraphs) ? j.paragraphs.map(clean).filter(Boolean) : []
  let signoff = clean(j.signoff).slice(0, 60)
  if (guessSignoff && !signoff && paras.length > 1 && paras[paras.length - 1]!.length <= 16) signoff = paras.pop()!
  if (paras.length === 0) return { kind: 'skip', reason: 'empty' }
  const kept: string[] = []
  let total = 0
  for (const p of paras) {
    if (kept.length > 0 && total + p.length > BODY_CAP) break
    kept.push(p.length > BODY_CAP ? p.slice(0, BODY_CAP) : p)
    total += p.length
  }
  paras = kept
  return { kind: 'letter', letter: { salutation: clean(j.salutation).slice(0, 40) || '你好:', paragraphs: paras, signoff } }
}

export function parseLetter(raw: string): ComposeResult {
  const j = extractJson(raw) as Record<string, unknown> | null
  if (!j || typeof j !== 'object' || (!('paragraphs' in j) && !('skip' in j))) return parsePlain(raw)
  if (typeof j.skip === 'string' || j.skip === true) return { kind: 'skip', reason: clean(j.skip) || 'thin_material' }
  return finish({ salutation: j.salutation, paragraphs: j.paragraphs, signoff: j.signoff }, false)
}

/** 纯文本版:存档、非 macOS 发微信时用。 */
export function letterText(l: LetterDraft): string {
  return [l.salutation, ...l.paragraphs.map(p => `  ${p}`), ...(l.signoff ? [l.signoff] : []), '— CC'].join('\n\n')
}
