import { IMAGE_MAX_BYTES } from '../state/image-upload'

// 分享给 CC(2026-10-18)的纯逻辑:系统交来的原始内容 ⇒ {正文, 要读的图, 不收的};去哪一页;草稿怎么并。不 import react / expo。
//
// 原始内容是 expo-share-intent 原生模块 onChange 的 value(不走它的 parseShareIntent:那个把安卓的 contentUri 换成了 filePath,
// 安卓 13 起没有媒体权限读不了那个路径;content:// 是随分享授权的)。两种形状:
// - iOS:JSON 字符串。{text,type:'text'} / {weburls:[{url,meta:'<json>'}],type:'weburl'} / {files:[{path,fileName,fileSize,mimeType}],type:'media'|'file'}
// - 安卓:对象。{text,type:'text',meta:{title}} / {files:[{contentUri,filePath,fileName,fileSize:'<字符串>',mimeType}],type:'file'}
//   (单张 SEND 的 files 里还夹着一个 "type" to "file" 的 Pair,不是文件,按缺 uri 丢掉)

/** 一张要读进来的图。encode:'jpeg' ⇒ 像相册选图那样重编成 JPEG(HEIC 也转);'raw' ⇒ GIF 原样读(重编会丢动画)。 */
export type ShareImageSource = { uri: string; name: string | null; mime: string; size: number | null; encode: 'jpeg' | 'raw' }
export type ShareDraft = {
  text: string
  images: ShareImageSource[]
  /** 超过一次能带的张数,多出来的没收 */
  overMax: boolean
  /** 不是文字 / 链接 / 图片的那几样(视频、PDF…):这一版不收,页面说一句 */
  unsupported: number
  /** 原样就超过 5MB 的 GIF:读都不读 */
  tooLarge: number
}

const obj = (x: unknown): Record<string, unknown> | null => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null)
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() !== '' ? x : null)
const num = (x: unknown): number | null => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}
function parseJson(s: string): unknown { try { return JSON.parse(s) } catch { return null } }

/** 网页标题 + 链接:标题已经在正文里(有的 app 分享时自己带上)就不重复。 */
export function withTitle(text: string, title: string | null): string {
  const t = text.trim(), h = title?.trim()
  if (!h || t.includes(h)) return t
  return t ? `${h}\n${t}` : h
}

const uriOf = (f: Record<string, unknown>): string | null => {
  // 安卓优先 content://(随分享授权);iOS 是 App Group 里复制好的 file://
  const content = str(f.contentUri)
  if (content) return content
  const p = str(f.path)
  if (p) return p
  const fp = str(f.filePath)
  return fp ? (fp.startsWith('file://') ? fp : `file://${fp}`) : null
}

export function normalizeShare(raw: unknown, max: number): ShareDraft {
  const v = obj(typeof raw === 'string' ? parseJson(raw) : raw)
  const out: ShareDraft = { text: '', images: [], overMax: false, unsupported: 0, tooLarge: 0 }
  if (!v) return out
  const meta = obj(v.meta)
  const text = str(v.text)
  if (text) out.text = withTitle(text, str(meta?.title))
  const urls = Array.isArray(v.weburls) ? v.weburls.map(obj).filter(u => !!u && !!str(u.url)) : []
  if (!text && urls.length) {
    out.text = urls.map(u => {
      const m = obj(typeof u!.meta === 'string' ? parseJson(u!.meta) : u!.meta)
      return withTitle(str(u!.url)!, str(m?.title))
    }).join('\n\n')
  }
  const files = Array.isArray(v.files) ? v.files.map(obj).filter((f): f is Record<string, unknown> => !!f && !!uriOf(f)) : []
  for (const f of files) {
    const mime = (str(f.mimeType) ?? '').toLowerCase()
    if (!mime.startsWith('image/')) { out.unsupported++; continue }
    if (out.images.length >= max) { out.overMax = true; continue }
    const size = num(f.fileSize ?? f.size)
    const encode = mime === 'image/gif' ? 'raw' : 'jpeg'
    if (encode === 'raw' && size !== null && size > IMAGE_MAX_BYTES) { out.tooLarge++; continue }
    out.images.push({ uri: uriOf(f)!, name: str(f.fileName), mime, size, encode })
  }
  return out
}

/** 两个去处:跟 CC 说 ⇒ 对话页(草稿键 'chat');交给 CC 做一件事 ⇒ 新交办(草稿键 'new')。都只预填,不自动发。 */
export type ShareChoice = 'chat' | 'matter'
export function shareRoute(choice: ShareChoice): { href: '/chat' | '/compose'; draftKey: 'chat' | 'new' } {
  return choice === 'chat' ? { href: '/chat', draftKey: 'chat' } : { href: '/compose', draftKey: 'new' }
}

/** 没配对、也没选「先看看」⇒ 先去配对(分享留着,配好回来接着选);配了或在演示里 ⇒ 直接选。 */
export const shareGate = (s: { seenWelcome: boolean }): 'ready' | 'needsPair' => (s.seenWelcome ? 'ready' : 'needsPair')

/** 分享进来的字并进已有草稿:原来写了的留着,另起一行接上;同一段已经在里面(分享了两次)就不再加。 */
export function mergeDraftText(existing: string, shared: string): string {
  const s = shared.trim()
  if (!s) return existing
  if (!existing.trim()) return s
  if (existing.includes(s)) return existing
  return `${existing.replace(/\s+$/, '')}\n${s}`
}

/** iOS 分享扩展开的链接(tendhearth://dataUrl=<scheme>ShareKey?nonce=…#text|weburl|media|file)。 */
export const isShareExtensionUrl = (url: string | null | undefined): boolean => !!url && /^[a-z][a-z0-9+.-]*:\/\/dataUrl=/i.test(url)
