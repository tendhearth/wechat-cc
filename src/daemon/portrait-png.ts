/**
 * portrait-png.ts — 「CC 画的你」给手机 App 的 PNG(收敛清单 ④,2026-10-21)。
 * 原生 App 没有 SVG 渲染,GET /m/api/state 另带一份 base64 PNG(portraitPng):macOS 上用 qlmanage 画成 512px 方图,
 * 别的平台没有 ⇒ 这个字段不出现。
 *
 * - 按 SVG 的 sha256 记在内存里(成败都记),同一张图只画一次;同一张图同时来几次请求只起一个进程。
 * - 请求最多等 waitMs;画得慢 ⇒ 这一次不带,画完进缓存,下一次就有。子进程自己 5 秒超时被杀。
 * - 临时文件在 stateDir/tmp 下,画完就删(lib/svg-raster)。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { rasterizeSvgToPng } from '../lib/svg-raster'

export const PORTRAIT_PNG_SIZE = 512
/** 一次请求最多等多久(首次画图);之后都走缓存。 */
export const PORTRAIT_WAIT_MS = 3000
const CACHE_MAX = 8

/** 画一张 SVG ⇒ base64 PNG;画不了 ⇒ null。 */
export type PortraitRender = (svg: string) => Promise<string | null>

export function makePortraitPng(o: { stateDir: string; render?: PortraitRender; waitMs?: number }): (svg: string) => Promise<string | null> {
  const render: PortraitRender = o.render ?? (async svg => {
    const png = await rasterizeSvgToPng(svg, join(o.stateDir, 'tmp'), PORTRAIT_PNG_SIZE)
    return png ? png.toString('base64') : null
  })
  const waitMs = o.waitMs ?? PORTRAIT_WAIT_MS
  const cache = new Map<string, string | null>()
  const inFlight = new Map<string, Promise<string | null>>()
  return async svg => {
    const key = createHash('sha256').update(svg).digest('hex')
    if (cache.has(key)) return cache.get(key)!
    let p = inFlight.get(key)
    if (!p) {
      p = render(svg).catch(() => null).then(v => {
        if (cache.size >= CACHE_MAX) cache.clear()
        cache.set(key, v)
        inFlight.delete(key)
        return v
      })
      inFlight.set(key, p)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>(r => { timer = setTimeout(() => r(null), waitMs) })
    try { return await Promise.race([p, late]) } finally { clearTimeout(timer) }
  }
}
