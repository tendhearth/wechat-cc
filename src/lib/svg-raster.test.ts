import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rasterizeSvgFileSync, rasterizeSvgToPng } from './svg-raster'

// 不起真的 qlmanage:换成一条把 SVG 原样拷成「<输入>.png」的命令(qlmanage 的输出名就是这样);平台也注入。
const copyCmd = (svgPath: string) => ['cp', svgPath, `${svgPath}.png`]
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>'
const dirs: string[] = []
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'svg-raster-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('svg-raster', () => {
  it('不是 macOS ⇒ null,什么都不写', async () => {
    const d = fresh()
    expect(rasterizeSvgFileSync(SVG, join(d, 'x'), 'p', 512, { platform: 'linux' })).toBeNull()
    expect(await rasterizeSvgToPng(SVG, join(d, 'y'), 512, 1000, { platform: 'win32' })).toBeNull()
    expect(readdirSync(d)).toEqual([])
  })
  it('同步版:dir/<name>.png;命令带上尺寸与输出目录', () => {
    const d = fresh()
    let seen: string[] = []
    const out = rasterizeSvgFileSync(SVG, d, 'page-1', 1600, { platform: 'darwin', command: (s, o, n) => { seen = [o, String(n)]; return copyCmd(s) } })
    expect(out).toBe(join(d, 'page-1.png'))
    expect(readFileSync(out!, 'utf8')).toBe(SVG)
    expect(seen).toEqual([d, '1600'])
  })
  it('异步版:回字节,临时目录删干净;命令失败 ⇒ null', async () => {
    const d = fresh()
    const png = await rasterizeSvgToPng(SVG, d, 512, 5000, { platform: 'darwin', command: copyCmd })
    expect(png?.toString('utf8')).toBe(SVG)
    expect(readdirSync(d)).toEqual([])
    expect(await rasterizeSvgToPng(SVG, d, 512, 5000, { platform: 'darwin', command: () => ['false'] })).toBeNull()
    expect(readdirSync(d)).toEqual([])
  })
  it('异步版:超时 ⇒ 杀掉、回 null,不等子进程', async () => {
    const d = fresh()
    const t0 = Date.now()
    expect(await rasterizeSvgToPng(SVG, d, 512, 200, { platform: 'darwin', command: () => ['sleep', '10'] })).toBeNull()
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(existsSync(d) && readdirSync(d)).toEqual([])
  })
})
