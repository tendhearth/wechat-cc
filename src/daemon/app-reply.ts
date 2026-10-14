/**
 * app-reply — 桌面 / 手机那一轮回复的附件与旁白,给 app 看的形状(回复交付 2026-10-04)。
 *
 * daemon 模式的 app 轮,接收器(reply-sinks.ts)收下的是整个 TurnReply:文字之外还有附件(语音 / 表情 /
 * 文件,模型调用顺序)与旁白(最后的话之前的过程话,不发微信)。这里把它们投成 app 能用、能落库的形状:
 *
 *   voice    { text }                   —— 要读出来的那句。桌面经 agent_speak、手机经 GET /m/api/chat/voice 按需合成。
 *   sticker  { label, file? }           —— 本地表情:file 是表情库里的文件名(解析一次、落库,桌面与手机看到同一张);
 *                                          联网表情(情绪 + 网址 / 搜索词)只有 label —— daemon 不替 app 去外网取图。
 *   file     { name, path }             —— path 只留在 daemon 与桌面的 Rust 层(在访达里显示);手机线上只给 name,
 *                                          不为它开取文件的路由。
 *
 * 落库在 messages.extras(v72,回复那一行),手机从消息库拉对话时随行带出。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CHAT_NARRATION_MAX, CHAT_TEXT_MAX, type ChatAttachmentT } from '@wechat-cc/protocol'
import type { TurnAttachment } from '../core/turn-reply'

export type AppAttachment =
  | { kind: 'voice'; text: string }
  | { kind: 'sticker'; label: string; file?: string }
  | { kind: 'file'; name: string; path: string }

export interface AppReplyExtras { attachments: AppAttachment[]; narration: string[] }

/** 旁白的统一收口:去空白段、只留最后 CHAT_NARRATION_MAX 段、每段至多 CHAT_TEXT_MAX 字。 */
export function normalizeNarration(narration: readonly string[]): string[] {
  return narration
    .map(s => s.trim())
    .filter(s => s !== '')
    .slice(-CHAT_NARRATION_MAX)
    .map(s => (s.length > CHAT_TEXT_MAX ? s.slice(0, CHAT_TEXT_MAX) : s))
}

/**
 * TurnAttachment → AppAttachment。`stickerFile(tag)` 是表情库的 resolve(绝对路径);只留文件名。
 * 解析不到(标签后来被删了)⇒ 仍保留一个只有 label 的表情,不假装有图。
 */
export function projectReplyExtras(
  input: { attachments: readonly TurnAttachment[]; narration: readonly string[] },
  deps: { stickerFile?(tag: string): string | null } = {},
): AppReplyExtras {
  const attachments: AppAttachment[] = []
  for (const a of input.attachments) {
    if (a.kind === 'voice') attachments.push({ kind: 'voice', text: a.text })
    else if (a.kind === 'file') attachments.push({ kind: 'file', name: basename(a.path), path: a.path })
    else if (a.kind === 'sticker') {
      const ref = a.ref
      if ('tag' in ref) {
        let file: string | null = null
        try { file = deps.stickerFile?.(ref.tag) ?? null } catch { file = null }
        attachments.push({ kind: 'sticker', label: ref.tag, ...(file ? { file: basename(file) } : {}) })
      } else {
        attachments.push({ kind: 'sticker', label: ref.mood })
      }
    }
  }
  return { attachments, narration: normalizeNarration(input.narration) }
}

export function hasExtras(x: AppReplyExtras | null | undefined): x is AppReplyExtras {
  return !!x && (x.attachments.length > 0 || x.narration.length > 0)
}

/** 落库用;两样都空 ⇒ undefined(这一行不写 extras,与旧行一样是 NULL)。 */
export function encodeExtras(x: AppReplyExtras | null | undefined): string | undefined {
  return hasExtras(x) ? JSON.stringify({ attachments: x.attachments, narration: x.narration }) : undefined
}

const str = (v: unknown): v is string => typeof v === 'string'

/** 从库里读回来:逐条核形状,坏的丢掉;整体坏了 ⇒ null(当没有)。 */
export function parseExtras(raw: string | null | undefined): AppReplyExtras | null {
  if (!raw) return null
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as { attachments?: unknown; narration?: unknown }
  const attachments: AppAttachment[] = []
  for (const a of Array.isArray(o.attachments) ? o.attachments : []) {
    if (!a || typeof a !== 'object') continue
    const x = a as Record<string, unknown>
    if (x.kind === 'voice' && str(x.text)) attachments.push({ kind: 'voice', text: x.text })
    else if (x.kind === 'sticker' && str(x.label)) attachments.push({ kind: 'sticker', label: x.label, ...(str(x.file) && x.file === basename(x.file) ? { file: x.file } : {}) })
    else if (x.kind === 'file' && str(x.name) && str(x.path)) attachments.push({ kind: 'file', name: x.name, path: x.path })
  }
  const narration = normalizeNarration(Array.isArray(o.narration) ? o.narration.filter(str) : [])
  return { attachments, narration }
}

/** 手机线上形状:文件只给名字(路径永远不出 daemon 到手机)。 */
export function phoneAttachment(a: AppAttachment): ChatAttachmentT {
  return a.kind === 'file' ? { kind: 'file', name: a.name } : a
}

/** 一行消息的 extras → 手机 ChatMessage 的两个可选字段;没有就是空对象(老形状)。 */
export function phoneExtrasFields(raw: string | null | undefined): { attachments?: ChatAttachmentT[]; narration?: string[] } {
  const x = parseExtras(raw)
  if (!hasExtras(x)) return {}
  return {
    ...(x.attachments.length ? { attachments: x.attachments.map(phoneAttachment) } : {}),
    ...(x.narration.length ? { narration: x.narration } : {}),
  }
}

/** 桌面 converse 的回包:本地表情多带一张 data URI(桌面的 CSP 只许 data: / blob: 图,不能直接指文件)。不落库。 */
export type ConverseAttachment =
  | Exclude<AppAttachment, { kind: 'sticker' }>
  | { kind: 'sticker'; label: string; file?: string; image?: string }

/** 桌面「此刻」里拖进 / 粘进来的图(2026-10-05)与文件(2026-10-06):路由已校验并解码,companionConverse 落到 inbox
 *  当附件交给 CC(图 ⇒ image,其余 ⇒ file)。name 只用来让落盘的文件名带上原名(CC 看得出是什么),不当路径用。 */
export interface ConverseImage { mime: string; bytes: Uint8Array; name?: string }
const CONVERSE_FILE_MIMES: Record<string, string> = {
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}
/** 一次最多几份、每份多大、认哪些格式 —— 路由与测试共用。 */
export const CONVERSE_IMAGE_LIMITS = { count: 4, bytes: 10 * 1024 * 1024, mimes: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', ...CONVERSE_FILE_MIMES } as Record<string, string> }
export const isConverseImageMime = (mime: string) => mime.startsWith('image/')
/** 落盘文件名里的原名部分:只留字母数字、中文、横线、下划线(点也换掉,扩展名按 mime 定),最多 60 字。 */
export function converseFileStem(name: string | undefined): string {
  const base = (name ?? '').replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60)
  return base
}

export interface ConverseResult { reply: string; attachments?: ConverseAttachment[]; narration?: string[] }

/** 内联进桌面回包的表情图至多这么大;再大就只显示 label。 */
export const STICKER_INLINE_MAX_BYTES = 1_048_576

const STICKER_MIME: Record<string, string> = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' }

/** 表情库里一个文件 → data URI。只认库目录下的纯文件名(与 /m/api/sticker/ 同样的 basename 守卫);读不到 / 太大 ⇒ null。 */
export function stickerDataUri(dir: string, file: string): string | null {
  if (!file || basename(file) !== file) return null
  const mime = STICKER_MIME[file.split('.').pop()?.toLowerCase() ?? '']
  if (!mime) return null
  const fp = join(dir, file)
  try {
    if (!existsSync(fp)) return null
    const st = statSync(fp)
    if (!st.isFile() || st.size > STICKER_INLINE_MAX_BYTES) return null
    return `data:${mime};base64,${readFileSync(fp).toString('base64')}`
  } catch { return null }
}

export function withStickerImages(atts: readonly AppAttachment[], image: (file: string) => string | null): ConverseAttachment[] {
  return atts.map(a => {
    if (a.kind !== 'sticker' || !a.file) return a
    const uri = image(a.file)
    return uri ? { ...a, image: uri } : a
  })
}
