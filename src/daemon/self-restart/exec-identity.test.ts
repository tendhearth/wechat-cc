import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readExecIdentity, execIdentityChanged } from './exec-identity'

describe('exec-identity', () => {
  it('读不到文件 ⇒ null,而不是抛错', () => {
    expect(readExecIdentity('/definitely/not/here/wechat-cc-cli')).toBeNull()
  })

  it('同一个文件没动过 ⇒ 未变化', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-exec-id-'))
    try {
      const p = join(dir, 'cli'); writeFileSync(p, 'v1')
      const a = readExecIdentity(p), b = readExecIdentity(p)
      expect(a).not.toBeNull()
      expect(execIdentityChanged(a, b)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('更新器用 rename 换入新文件(新 inode) ⇒ 变化', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-exec-id-'))
    try {
      const p = join(dir, 'cli'); writeFileSync(p, 'v1')
      const boot = readExecIdentity(p)
      // 同 tauri-plugin-updater 与本仓库的换法:写到旁边再 rename 过去
      writeFileSync(join(dir, 'cli.new'), 'v1'); // 内容相同、长度相同,只有 inode 不同
      rmSync(p); writeFileSync(p, 'v1') // 用删除+新建模拟 rename 后的新 inode
      expect(execIdentityChanged(boot, readExecIdentity(p))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('原地改写(同 inode、内容变了) ⇒ 变化', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-exec-id-'))
    try {
      const p = join(dir, 'cli'); writeFileSync(p, 'v1')
      const boot = readExecIdentity(p)
      writeFileSync(p, 'v2-longer'); utimesSync(p, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
      expect(execIdentityChanged(boot, readExecIdentity(p))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('任一侧读不到 ⇒ 视为未变化(宁可不动,也不能因为一次 stat 抖动把 bot 踢下线)', () => {
    const some = { ino: 1, size: 2, mtimeMs: 3 }
    expect(execIdentityChanged(null, some)).toBe(false)
    expect(execIdentityChanged(some, null)).toBe(false)
    expect(execIdentityChanged(null, null)).toBe(false)
  })
})
