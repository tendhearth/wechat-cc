import { BackendError, type Backend } from '../backend/types'

/** 与 daemon 的分块上传同一个块大小(apps/mobile/src/attachments.js 的 PA_CHUNK_BYTES):续传时 nextOffset 必须是它的整数倍。 */
export const UPLOAD_CHUNK_BYTES = 128 * 1024
/** daemon 认的图片上限(core/workbench/attachments.ts 的 MAX_IMAGE_ATTACHMENT_BYTES)。超了在手机上就拦下,不白传。 */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/** 选好、还没发出去的一张图。id 在选的那一刻定下(就是材料 id),重发 / 续传都用它。 */
export type PickedImage = { id: string; name: string; mime: string; size: number; sha256: string; bytes: Uint8Array; uri: string }

export type ImageCheck = 'ok' | 'too_large' | 'unsupported'
export function checkImage(p: { mime: string; size: number }): ImageCheck {
  if (!(IMAGE_MIMES as readonly string[]).includes(p.mime)) return 'unsupported'
  if (p.size <= 0 || p.size > IMAGE_MAX_BYTES) return 'too_large'
  return 'ok'
}

/**
 * 把几张图依次传到电脑的材料暂存(2026-10-06)。每张先问一次进度(断线重连 / 重试时从断点续),再按 128 KiB 一块传完。
 * 一块出错 ⇒ 再问一次进度续传,最多 retries 次;还不行就把错误抛给调用方(这一句不发)。
 * 返回材料 id(与 PickedImage.id 相同),给 chatSay / create 引用。
 */
export async function uploadImages(
  backend: Pick<Backend, 'uploadChunk' | 'uploadStatus'>,
  draftId: string,
  images: readonly PickedImage[],
  toBase64: (bytes: Uint8Array) => string,
  retries = 2,
): Promise<string[]> {
  for (const img of images) {
    let failures = 0
    let offset = await resumeOffset(backend, img, draftId)
    while (offset < img.size) {
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, img.size)
      try {
        const s = await backend.uploadChunk({ id: img.id, draftId, name: img.name, mime: img.mime, size: img.size, sha256: img.sha256, offset, contentBase64: toBase64(img.bytes.subarray(offset, end)) })
        if (s.nextOffset < end) throw new BackendError('unknown')
        offset = s.nextOffset
        if (s.status === 'ready') break
      } catch (e) {
        if (++failures > retries || (e instanceof BackendError && (e.code === 'revoked' || e.code === 'images_gone' || e.code === 'invalid'))) throw e
        offset = await resumeOffset(backend, img, draftId)
      }
    }
  }
  return images.map(i => i.id)
}

async function resumeOffset(backend: Pick<Backend, 'uploadStatus'>, img: PickedImage, draftId: string): Promise<number> {
  try {
    const s = await backend.uploadStatus(img.id, draftId)
    return s.status === 'ready' ? img.size : s.nextOffset
  } catch (e) {
    // 电脑上还没有这一份 ⇒ 从头传;其它错误(离线 / 被撤销)照常抛
    if (e instanceof BackendError && e.code === 'not_found') return 0
    throw e
  }
}

/** 一次性的 base64(Hermes / 浏览器都有 btoa);分段拼,每段 8K,Hermes 的参数个数上限远不到 32K。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000))
  return btoa(s)
}
export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** 电脑把带图的一句记成什么样(daemon wiring/pipeline-deps.ts persistAppTurn):「原文\n[图片 ×N]」,只有图 ⇒「[图片 ×N]」。
 *  本机回执按它显示、按它认「已落地」—— 两边必须一字不差。 */
export function withImageMarker(text: string, count: number): string {
  return [text.trim(), `[图片 ×${count}]`].filter(Boolean).join('\n')
}
