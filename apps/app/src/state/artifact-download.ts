import { BackendError, type Backend } from '../backend/types'
import { base64ToBytes } from './image-upload'

/** 手机上一次最多读多大的成果(2026-10-06):整份放在内存里再交给预览 / 分享,太大的请到电脑上看。 */
export const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024

export type ArtifactRef = { id: string; name: string; mime: string; size: number; sha256: string }
export type ArtifactPreview = { kind: 'image' | 'text' | 'file' }
/** 图片在 app 里直接看;文字类(Markdown / 纯文本 / JSON / CSV)用阅读视图;其它(PDF / 网页 / 表格 / 压缩包)交给系统打开。 */
export function previewKind(mime: string, name: string): ArtifactPreview['kind'] {
  if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) return 'image'
  if (/^text\/(plain|markdown|csv)$/.test(mime) || mime === 'application/json' || /\.(md|txt|csv|json)$/i.test(name)) return 'text'
  return 'file'
}

/**
 * 按块把一份成果读完(与 /m 同一条路由),核对总长与 sha256(digest 由调用方给:RN 用 expo-crypto,测试用 node)。
 * 读到一半那份换了(daemon 回 artifact_changed / sha 对不上)⇒ BackendError('stale');太大 ⇒ 'too_large'。
 */
export async function downloadArtifact(
  backend: Pick<Backend, 'artifactChunk'>, matterId: string, a: ArtifactRef, sha256Hex: (bytes: Uint8Array) => Promise<string>,
): Promise<Uint8Array> {
  if (a.size > ARTIFACT_MAX_BYTES) throw new BackendError('too_large')
  const out = new Uint8Array(a.size)
  let offset = 0
  while (offset < a.size) {
    const c = await backend.artifactChunk({ id: matterId, artifactId: a.id, sha256: a.sha256, offset })
    const bytes = base64ToBytes(c.contentBase64)
    if (c.offset !== offset || c.size !== a.size || c.nextOffset !== offset + bytes.length || bytes.length === 0 || c.nextOffset > a.size) throw new BackendError('stale')
    out.set(bytes, offset)
    offset = c.nextOffset
  }
  if ((await sha256Hex(out)) !== a.sha256) throw new BackendError('stale')
  return out
}

export function humanSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * CC 回复里的一个文件(GET /m/api/chat/file,2026-10-06):大小与 sha256 由第一块告诉我们,读完整份核对。
 * 中途那份换了(大小 / 哈希变了)⇒ 'stale';超过上限 ⇒ 'too_large'(电脑那边也会 413)。
 */
export async function downloadReplyFile(
  backend: Pick<Backend, 'chatFileChunk'>, messageId: string, index: number, sha256Hex: (bytes: Uint8Array) => Promise<string>,
): Promise<Uint8Array> {
  let offset = 0, out: Uint8Array | null = null, size = 0, sha = ''
  for (;;) {
    const c = await backend.chatFileChunk({ messageId, index, offset })
    if (!out) {
      if (c.size > ARTIFACT_MAX_BYTES) throw new BackendError('too_large')
      out = new Uint8Array(c.size); size = c.size; sha = c.sha256
    }
    const bytes = base64ToBytes(c.contentBase64)
    if (c.size !== size || c.sha256 !== sha || c.offset !== offset || c.nextOffset !== offset + bytes.length || c.nextOffset > size) throw new BackendError('stale')
    out.set(bytes, offset)
    offset = c.nextOffset
    if (offset >= size) break
    if (!bytes.length) throw new BackendError('stale')
  }
  if ((await sha256Hex(out)) !== sha) throw new BackendError('stale')
  return out
}
