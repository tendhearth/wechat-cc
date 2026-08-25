/**
 * sticker-artist.ts — 觅食式表情生长 (2026-08-25, phase 2 of the starter
 * pack): the starter pack covers 开心/庆祝/送你/摸鱼/陪着; the moods it
 * CAN'T cover (安慰/晚安/加油/…) CC draws for itself — one per day at most,
 * announced to the owner like a small gift ("我画了张新表情~"), so the
 * library grows the way 觅食台 does.
 *
 * Pipeline: pick an uncovered mood → cheapEval draws an SVG of CC ITSELF
 * (小白熊) expressing it → same reject-only safeSvg gate as the portrait →
 * rasterize to PNG (macOS qlmanage; injectable for tests / silently off
 * where unavailable) → StickerLib.save → notify. Every failure mode is
 * non-fatal and stamps the daily marker, so a broken model/renderer costs
 * one attempt per day, never a hot loop.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeSvg } from '../lib/svg-sanitize'
import type { StickerLib } from './stickers'

/** Moods worth having a sticker for, in draw order (starter pack covers none of these). */
export const STICKER_MOOD_POOL: readonly string[] = [
  '安慰', '晚安', '加油', '收到', '疑问', '想你', '害羞', '谢谢', '大笑', '哭哭',
]

/** Min interval between draw attempts (~daily; introspect tick is 24h). */
const DRAW_INTERVAL_MS = 22 * 3600_000

const MARKER_FILE = 'sticker-artist.json'

export function pickMissingMood(existingTags: string[]): string | null {
  const have = new Set(existingTags.map(t => t.trim()))
  for (const mood of STICKER_MOOD_POOL) if (!have.has(mood)) return mood
  return null
}

export function buildStickerPrompt(mood: string): string {
  return (
    `你是 CC,一只圆滚滚的白色小熊。请画你自己正在表达「${mood}」的表情包。\n` +
    `硬性要求:\n` +
    `- 输出一个 SVG:根元素 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">\n` +
    `- 只允许这些元素:g/path/circle/ellipse/rect/line/polyline/polygon/title\n` +
    `- 属性一律双引号;禁止 style/class/id/href/text/image/use/script/动画\n` +
    `- 手绘感:stroke-width 3~6 的松弛线条;颜色只用 #5a3f2d(主线)、#b0563a(点缀)、#8a5a36、#f5ead8(奶白身体)、#f7b8b8(腮红)、none\n` +
    `- 构图:大圆脸小熊占满画面,表情要一眼读出「${mood}」,可加 1 个小道具(月亮/爱心/问号形状用图形拼)\n` +
    `**只输出 SVG,不要任何解释,不要代码围栏。**`
  )
}

/** SVG → 512px PNG via macOS qlmanage. Returns the PNG path or null. */
export async function rasterizeSvgDarwin(svg: string, workDir: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    mkdirSync(workDir, { recursive: true })
    const svgPath = join(workDir, 'sticker.svg')
    writeFileSync(svgPath, svg)
    const proc = Bun.spawnSync(['qlmanage', '-t', '-s', '512', '-o', workDir, svgPath])
    if (proc.exitCode !== 0) return null
    const out = `${svgPath}.png`
    if (!existsSync(out)) return null
    const finalPath = join(workDir, `cc-drawn-${Date.now()}.png`)
    renameSync(out, finalPath)
    return finalPath
  } catch {
    return null
  }
}

export interface StickerArtistDeps {
  stateDir: string
  lib: StickerLib
  cheapEval: (prompt: string) => Promise<string>
  /** Announce the new sticker to the owner (send sticker + a line of text). */
  notify: (mood: string) => Promise<void>
  log: (tag: string, line: string) => void
  rasterize?: (svg: string, workDir: string) => Promise<string | null>
  now?: () => number
}

export async function runStickerArtist(d: StickerArtistDeps): Promise<{ drawn: string | null }> {
  const now = d.now ?? (() => Date.now())
  const markerPath = join(d.stateDir, MARKER_FILE)

  const mood = pickMissingMood(d.lib.allTags())
  if (!mood) return { drawn: null }   // pool exhausted — free check, no marker churn

  // Daily gate — stamped on every ATTEMPT (success or failure) so a broken
  // model/renderer costs one try per day, never a retry loop.
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { last_at?: number }
    if (typeof marker.last_at === 'number' && now() - marker.last_at < DRAW_INTERVAL_MS) return { drawn: null }
  } catch { /* no marker yet */ }
  writeFileSync(markerPath, JSON.stringify({ last_at: now() }))

  const workDir = join(d.stateDir, 'tmp-sticker-artist')
  mkdirSync(workDir, { recursive: true })
  try {
    const raw = await d.cheapEval(buildStickerPrompt(mood))
    const m = raw.match(/<svg[\s\S]*<\/svg>/)
    const svg = m ? safeSvg(m[0]) : null
    if (!svg) {
      d.log('STICKERS', `artist: unsafe/absent SVG for 「${mood}」 — retry tomorrow`)
      return { drawn: null }
    }
    const png = await (d.rasterize ?? rasterizeSvgDarwin)(svg, workDir)
    if (!png) {
      d.log('STICKERS', `artist: rasterize unavailable/failed for 「${mood}」`)
      return { drawn: null }
    }
    d.lib.save(png, [mood], `CC 自己画的「${mood}」表情`)
    d.log('STICKERS', `artist: drew 「${mood}」 (${png.split('/').pop()})`)
    try {
      await d.notify(mood)
    } catch (e) {
      d.log('STICKERS', `artist: notify failed (sticker kept): ${String(e)}`)
    }
    return { drawn: mood }
  } catch (e) {
    d.log('STICKERS', `artist: draw failed for 「${mood}」: ${String(e)}`)
    return { drawn: null }
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* scratch only */ }
  }
}
