/**
 * openai-vision.ts — 让 openai 兼容那条路也能看图。
 *
 * 入站图片由 mw-attachments 落到 inbox,提示词里只剩一行 `[image:/abs/path]`(prompt-format)。
 * Claude 那条路靠自带看图的 Read 工具就够;openai 路的用户消息是纯字符串,模型只拿到路径。
 * 这里把路径挖出来、经 image-prep 整理(超过 2048 缩、超 8MB 拒)、作为 image 分块随用户
 * 消息一起送 —— AI SDK 的 openai-compatible 会把它变成 `image_url` 的 data URL。
 *
 * 照 Codex 的规矩:缩过的、没带上的,都在文字里说一句,模型知道自己看的是什么。
 */
import { prepareImage, type PrepareImageOpts } from '../lib/image-prep'

export interface ImagePart { data: Uint8Array; mediaType: string }

/** 一条消息最多带几张;更多的只留路径。 */
export const MAX_IMAGES_PER_TURN = 4

/** prompt-format 的附件行:`[image:/abs/path]`,路径里不会有 `]`。 */
export function extractImagePaths(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\[image:([^\]\n]+)\]/g)) {
    const p = m[1]!.trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

export interface PreparedParts { parts: ImagePart[]; notes: string[] }

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p

/**
 * 读得到、类型认得、缩得下的带上;每一张的结果都留一句给文字(缩了 / 没带上 / 超出张数)。
 */
export async function prepareImageParts(paths: string[], opts: PrepareImageOpts = {}, prepare = prepareImage): Promise<PreparedParts> {
  const parts: ImagePart[] = []
  const notes: string[] = []
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]!
    if (parts.length >= MAX_IMAGES_PER_TURN) { notes.push(`第 ${i + 1} 张图(${basename(p)})未附上:一条消息最多带 ${MAX_IMAGES_PER_TURN} 张`); continue }
    const r = await prepare(p, opts)
    if (!r.ok) { notes.push(`第 ${i + 1} 张图(${basename(p)})未附上:${r.reason}`); continue }
    parts.push({ data: r.data, mediaType: r.mediaType })
    if (r.resized) notes.push(`第 ${i + 1} 张图(${basename(p)})从 ${r.resized.from.w}x${r.resized.from.h} 缩到 ${r.resized.to.w}x${r.resized.to.h}`)
  }
  return { parts, notes }
}

/** 把整理说明缀在用户文字后面(Codex 用 developer 消息;Chat Completions 没有这层,就放同一条里)。 */
export function appendImageNotes(text: string, notes: string[]): string {
  if (notes.length === 0) return text
  return `${text}\n<image_notes>\n${notes.join('\n')}\n</image_notes>`
}
