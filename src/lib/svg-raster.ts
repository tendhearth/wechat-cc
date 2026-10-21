/**
 * svg-raster.ts — SVG → 方形 PNG,用 macOS 自带的 qlmanage(Quick Look 缩略图)。信纸、手机上的「CC 画的你」共用这一份;
 * 表情包(sticker-artist)走的也是同一条命令。别的平台没有这条路 ⇒ null,调用方自己退路(发文字 / 不给图)。
 *
 * qlmanage 出的缩略图永远是正方形,输出名固定是「<输入>.png」。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { spawn, spawnSync } from './runtime/process'

export type RasterOpts = {
  /** 测试注入;默认 process.platform。 */
  platform?: NodeJS.Platform
  /** 测试注入;默认 qlmanage -t -s <size> -o <outDir> <svgPath>。 */
  command?: (svgPath: string, outDir: string, size: number) => string[]
}
const qlmanage = (svgPath: string, outDir: string, size: number) => ['qlmanage', '-t', '-s', String(size), '-o', outDir, svgPath]

/** 同步版:写到 dir/<name>.png 并回路径。信纸在后台任务里一页一页画,沿用同步。 */
export function rasterizeSvgFileSync(svg: string, dir: string, name: string, size: number, o: RasterOpts = {}): string | null {
  if ((o.platform ?? process.platform) !== 'darwin') return null
  try {
    mkdirSync(dir, { recursive: true })
    const svgPath = join(dir, `${name}.svg`)
    writeFileSync(svgPath, svg)
    const r = spawnSync((o.command ?? qlmanage)(svgPath, dir, size))
    const out = `${svgPath}.png`
    if (r.exitCode !== 0 || !existsSync(out)) return null
    const png = join(dir, `${name}.png`)
    renameSync(out, png)
    return png
  } catch {
    return null
  }
}

/**
 * 异步版,带超时:在 dir 下开一个临时子目录画完读回字节,临时文件一律删掉。超时 ⇒ 杀掉子进程、回 null。
 * 给请求路径用(不阻塞事件循环)。
 */
export async function rasterizeSvgToPng(svg: string, dir: string, size: number, timeoutMs = 5000, o: RasterOpts = {}): Promise<Buffer | null> {
  if ((o.platform ?? process.platform) !== 'darwin') return null
  const work = join(dir, `svg-raster-${randomBytes(6).toString('hex')}`)
  try {
    mkdirSync(work, { recursive: true })
    const svgPath = join(work, 'in.svg')
    writeFileSync(svgPath, svg)
    const p = spawn((o.command ?? qlmanage)(svgPath, work, size), { stdout: 'ignore', stderr: 'ignore' })
    let timer: ReturnType<typeof setTimeout> | undefined
    const code = await Promise.race([p.exited, new Promise<null>(r => { timer = setTimeout(() => r(null), timeoutMs) })])
    clearTimeout(timer)
    if (code === null) { try { p.kill() } catch { /* 已退 */ } return null }
    const out = `${svgPath}.png`
    if (code !== 0 || !existsSync(out)) return null
    return readFileSync(out)
  } catch {
    return null
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* 删不掉就留着,下次照样新开一个 */ }
  }
}
