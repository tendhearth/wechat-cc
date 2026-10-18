/**
 * media-mirror.ts — CC 在微信上发给主人的图 / 表情 / 语音 / 文件,App 对话页也看得见(手机伙伴第 2 步,2026-10-18)。
 *
 * 文字一直有:ilink.sendMessage 成功就记一行(所有 chat 都记,那是消息库的老规矩)。媒体以前不记 ——
 * App 对话页只看得到 App / 桌面那一轮落库的附件。现在 sendFile / 语音成功之后,**只对主人那条对话**
 * (App 镜像的那一条)记一行 CC,附件放 extras,形状与 App 轮的回复行一样(app-reply.ts),ReplyExtras 照常画:
 *
 *   - 表情库里的图 ⇒ sticker { label, file }:file 只是文件名,手机经 GET /m/api/sticker/ 取;
 *   - 别的文件(图片、信纸、PDF …)⇒ file { name, path }:path 只留在 daemon,手机经 GET /m/api/chat/file 按块读
 *     (图片在 App 里直接画成图);
 *   - 语音 ⇒ voice { text }:不存音频,手机点了再经 GET /m/api/chat/voice 合成同一段。
 *
 * 只存指向磁盘上已有文件的引用,不往 sqlite 里塞字节。发完就删的临时文件(联网表情的下载、TTS 的中间文件)不记 ——
 * 手机过后取不到,记了只是一个打不开的框;联网表情存进表情库之后由路由按库里的文件名另记一次。
 * 其它 chat 不记(不给别人的对话开新规矩)。记账失败只记日志,绝不影响发送结果。
 */
import { basename, dirname, relative, isAbsolute, resolve } from 'node:path'
import { encodeExtras, type AppAttachment } from '../app-reply'
import type { MessageRecord } from '../../lib/messages-store'

/** 微信那头真的送出去了的一样东西(ilink-glue 在 sendFile / replyVoice 成功之后报上来)。 */
export type SentMedia =
  | { kind: 'file'; path: string }
  | { kind: 'voice'; text: string }
  /** 联网表情:发的是临时下载,存进表情库之后由路由按库里的文件名报。 */
  | { kind: 'sticker'; file: string; label: string }

export interface MediaMirrorDeps {
  /** App 镜像的那条主人对话(makePhoneChatId 认的那条);没有 ⇒ null(什么都不记)。 */
  ownerChatId(): string | null
  /** 表情库目录;没接表情库 ⇒ null(表情库里的图就当普通图片记)。 */
  stickerDir: string | null
  /** 表情库里这个文件的标签(取第一个)。 */
  stickerLabel(file: string): string | null
  /** 这些目录下的文件发完就删(系统临时目录、TTS 中间文件),不记。 */
  scratchRoots: string[]
  append(rec: MessageRecord): Promise<number>
  /** 记了一行之后:「一件事」活动时间 + 手机主题重算(开着的 App 立刻刷新)。 */
  touched(): void
  now?: () => number
  log(tag: string, line: string): void
}

export interface MediaMirror {
  /** 发给 chatId 的东西成功了;是主人那条才记。一次报几样 ⇒ 记成一行(一封信的几页)。只投不等。 */
  noteSent(chatId: string, m: SentMedia | readonly SentMedia[]): void
}

const inside = (root: string, p: string): boolean => {
  const r = relative(resolve(root), resolve(p))
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

/** 一样送出去的东西 → App 附件;临时文件 ⇒ null(不记)。纯函数,测试直接调。 */
export function mirrorAttachment(m: SentMedia, o: Pick<MediaMirrorDeps, 'stickerDir' | 'stickerLabel' | 'scratchRoots'>): AppAttachment | null {
  if (m.kind === 'voice') return m.text.trim() ? { kind: 'voice', text: m.text } : null
  if (m.kind === 'sticker') return m.file && basename(m.file) === m.file ? { kind: 'sticker', label: m.label, file: m.file } : null
  if (!m.path || !isAbsolute(m.path)) return null
  if (o.scratchRoots.some(r => inside(r, m.path))) return null
  const name = basename(m.path)
  if (o.stickerDir && resolve(dirname(m.path)) === resolve(o.stickerDir)) {
    let label: string | null = null
    try { label = o.stickerLabel(name) } catch { label = null }
    return { kind: 'sticker', label: label ?? name.replace(/\.[^.]+$/, ''), file: name }
  }
  return { kind: 'file', name, path: m.path }
}

/** 一行主人对话里 CC 的「只有附件」的话(文字为空,ChatBubble 不画空气泡)。App 落地的那条路(app-channel)也用它。 */
export function attachmentRow(o: { id: string; chatId: string; at: number; attachments: AppAttachment[]; text?: string; source: string }): MessageRecord {
  const first = o.attachments[0]
  const extras = encodeExtras({ attachments: o.attachments, narration: [] })
  return {
    id: o.id, chatId: o.chatId, ts: new Date(o.at).toISOString(), direction: 'out',
    // kind 给读消息库的其它地方(写信取材只认 text)一个提示:这一行不是一句话。
    kind: o.text?.trim() ? 'text' : first ? first.kind : 'text',
    text: o.text ?? '', source: o.source,
    ...(extras ? { extras } : {}),
  }
}

export function makeMediaMirror(deps: MediaMirrorDeps): MediaMirror {
  const now = deps.now ?? (() => Date.now())
  let seq = 0
  return {
    noteSent(chatId, m) {
      let owner: string | null = null
      try { owner = deps.ownerChatId() } catch { owner = null }
      if (!owner || owner !== chatId) return
      const list: readonly SentMedia[] = Array.isArray(m) ? (m as readonly SentMedia[]) : [m as SentMedia]
      const atts = list.map(x => mirrorAttachment(x, deps)).filter((a): a is AppAttachment => !!a)
      if (!atts.length) return
      const t = now()
      // source 'live':这一样是在微信上发的(App 上看到「来自微信」),与 sendMessage 记的文字行同一个来源。
      const rec = attachmentRow({ id: `out:media:${t}:${seq++}`, chatId, at: t, attachments: atts, source: 'live' })
      void deps.append(rec).then(
        () => { try { deps.touched() } catch { /* 刷新只是提早看见 */ } },
        e => deps.log('MESSAGES', `media mirror record failed: ${e instanceof Error ? e.message : String(e)}`),
      )
    },
  }
}
