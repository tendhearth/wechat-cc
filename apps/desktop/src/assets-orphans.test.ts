// 仓库守卫:apps/desktop/src 整个目录会被 Tauri 打进正式包(frontendDist = ../src),
// 没人引用的图片也一样出厂。2026-09-10 清理时一次删掉了 78 张、50MB 的旧熊 / 旧场景素材。
// 规则:src/assets 下每张图的文件名都必须在 src 里某个非 assets 文件(或 tauri.conf.json)中出现。
// pet/ 子树不在此列,它有自己的 manifest + validator 管引用。
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'

const ROOT = join(__dirname)
const IMAGE = new Set(['.png', '.webp', '.jpg', '.jpeg', '.svg', '.gif'])
const TEXT = new Set(['.js', '.ts', '.html', '.css', '.json', '.md'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out); else out.push(full)
  }
  return out
}

describe('desktop 前端资产守卫', () => {
  it('src/assets 下每张图都有人引用(pet/ 除外)', () => {
    const all = walk(ROOT)
    const referrers = all.filter(f => !relative(ROOT, f).startsWith('assets/') && TEXT.has(extname(f)))
    const blob = referrers.map(f => readFileSync(f, 'utf8')).join('\n') + readFileSync(join(ROOT, '../src-tauri/tauri.conf.json'), 'utf8')
    const orphans = all
      .filter(f => relative(ROOT, f).startsWith('assets/') && !relative(ROOT, f).startsWith('assets/pet/') && IMAGE.has(extname(f).toLowerCase()))
      .filter(f => !blob.includes(f.slice(f.lastIndexOf('/') + 1)))
      .map(f => relative(ROOT, f))
    expect(orphans, `这些图没人引用却会随正式包出厂 —— 删掉或接上:\n  ${orphans.join('\n  ')}`).toEqual([])
  })
})
