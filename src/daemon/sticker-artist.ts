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

/** Phase-1 moods (基础情绪) — drawn one per DAY until covered. */
export const STICKER_MOOD_POOL: readonly string[] = [
  '安慰', '晚安', '加油', '收到', '疑问', '想你', '害羞', '谢谢', '大笑', '哭哭',
]

/** Phase-2 moods (扩展) — drawn one per WEEK once phase 1 is covered. */
export const STICKER_MOOD_POOL_EXTENDED: readonly string[] = [
  '抱抱', '冲鸭', '饿了', '困了', '无语', '点赞', '生气', '放空', '期待', '汗',
]

/** Growth curve (owner 2026-08-25: 一开始克制每天一张,慢慢积攒):
 *  phase 1 daily → phase 2 weekly → hard cap. */
const DAILY_MS = 22 * 3600_000
const WEEKLY_MS = 166 * 3600_000
/** Total CC-drawn stickers after which the artist retires its brush. */
export const CC_DRAWN_CAP = 40

/** CC-drawn files are recognizable by this basename prefix (see rasterize). */
const DRAWN_PREFIX = 'cc-drawn-'

const MARKER_FILE = 'sticker-artist.json'

export function pickMissingMood(existingTags: string[], pool: readonly string[] = STICKER_MOOD_POOL): string | null {
  const have = new Set(existingTags.map(t => t.trim()))
  for (const mood of pool) if (!have.has(mood)) return mood
  return null
}

export interface DrawTarget {
  mood: string
  /** true ⇒ a NEW take on an already-covered mood (adds variety — resolve()
   *  picks randomly among a tag's stickers). */
  variation: boolean
  intervalMs: number
}

/** The growth curve's next step, or null when the artist is done. */
export function pickDrawTarget(
  entries: Array<{ file: string; tags: string[] }>,
  random: () => number = Math.random,
): DrawTarget | null {
  const tags = [...new Set(entries.flatMap(e => e.tags))]
  const phase1 = pickMissingMood(tags, STICKER_MOOD_POOL)
  if (phase1) return { mood: phase1, variation: false, intervalMs: DAILY_MS }
  const drawn = entries.filter(e => e.file.startsWith(DRAWN_PREFIX))
  if (drawn.length >= CC_DRAWN_CAP) return null
  const phase2 = pickMissingMood(tags, STICKER_MOOD_POOL_EXTENDED)
  if (phase2) return { mood: phase2, variation: false, intervalMs: WEEKLY_MS }
  // Everything covered — weekly variations of CC's own moods for variety.
  if (drawn.length === 0) return null
  const pick = drawn[Math.floor(random() * drawn.length)]!
  const mood = pick.tags[0]
  return mood ? { mood, variation: true, intervalMs: WEEKLY_MS } : null
}

export function buildStickerPrompt(mood: string, opts?: { variation?: boolean }): string {
  const variationLine = opts?.variation
    ? `你以前画过「${mood}」,这次换一个完全不同的构图/姿势/小道具再画一张。\n`
    : ''
  return (
    `你是 CC,一只圆滚滚的白色小熊。请画你自己正在表达「${mood}」的表情包。\n` + variationLine +
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

  const target = pickDrawTarget(d.lib.list())
  if (!target) return { drawn: null }   // curve finished — free check, no marker churn

  // Cadence gate (daily in phase 1, weekly after) — stamped on every ATTEMPT
  // (success or failure) so a broken model/renderer costs one try per
  // period, never a retry loop.
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { last_at?: number }
    if (typeof marker.last_at === 'number' && now() - marker.last_at < target.intervalMs) return { drawn: null }
  } catch { /* no marker yet */ }
  writeFileSync(markerPath, JSON.stringify({ last_at: now() }))
  const mood = target.mood

  const workDir = join(d.stateDir, 'tmp-sticker-artist')
  mkdirSync(workDir, { recursive: true })
  try {
    const raw = await d.cheapEval(buildStickerPrompt(mood, { variation: target.variation }))
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
    d.lib.save(png, [mood], `CC 自己画的「${mood}」表情${target.variation ? '(新版本)' : ''}`)
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
