/**
 * openai-vision.ts — 让 openai 兼容那条路也能看图。
 *
 * 入站图片由 mw-attachments 落到 inbox,提示词里只剩一行 `[image:/abs/path]`(prompt-format)。
 * Claude 那条路靠自带看图的 Read 工具就够;openai 路的用户消息是纯字符串,模型只拿到路径。
 * 这里把路径挖出来、读成字节,作为 image 分块随用户消息一起送 —— AI SDK 的
 * openai-compatible 会把它变成 `image_url` 的 data URL。KIMI / GLM / Qwen 都吃这个。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

export interface ImagePart { data: Uint8Array; mediaType: string }

/** 一条消息最多带几张;更多的只留路径。 */
export const MAX_IMAGES_PER_TURN = 4
/** 单张上限 —— data URL 进上下文,太大既慢又贵。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
}

/** prompt-format 的附件行:`[image:/abs/path]`,路径里不会有 `]`。 */
export function extractImagePaths(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\[image:([^\]\n]+)\]/g)) {
    const p = m[1]!.trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

export function imageMediaType(path: string): string | null {
  return MIME[extname(path).toLowerCase()] ?? null
}

export interface LoadImageDeps {
  exists?: (p: string) => boolean
  size?: (p: string) => number
  read?: (p: string) => Uint8Array
}

/** 读得到、类型认得、不超限的才带;别的静默跳过(路径仍在文字里,模型至少知道有张图)。 */
export function loadImageParts(paths: string[], deps: LoadImageDeps = {}): ImagePart[] {
  const exists = deps.exists ?? existsSync
  const size = deps.size ?? ((p: string) => statSync(p).size)
  const read = deps.read ?? ((p: string) => new Uint8Array(readFileSync(p)))
  const parts: ImagePart[] = []
  for (const p of paths) {
    if (parts.length >= MAX_IMAGES_PER_TURN) break
    const mediaType = imageMediaType(p)
    if (!mediaType) continue
    try {
      if (!exists(p) || size(p) > MAX_IMAGE_BYTES) continue
      parts.push({ data: read(p), mediaType })
    } catch { /* 读不到就当没有 */ }
  }
  return parts
}
