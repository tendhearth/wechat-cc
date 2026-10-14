import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 2026-10-10:access.ts 原先在模块加载时把 access.json 的路径定死(join(STATE_DIR, …))。e2e 一个文件里
// 起好几个 daemon(各自的 WECHAT_STATE_DIR),后面的 daemon 一直读第一个 daemon 的目录 —— 那个目录在第一条
// 用例收尾时就删了;5 秒缓存过期后读到空 access ⇒ 消息按「不在白名单」丢掉(CI 上 reply-tool-bridge 一天三红)。
describe('loadAccess follows the current state dir', () => {
  const dirs: string[] = []
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
  const dirWith = (admins: string[]) => {
    const d = mkdtempSync(join(tmpdir(), 'access-path-')); dirs.push(d)
    writeFileSync(join(d, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['*'], admins }))
    return d
  }
  it('switching WECHAT_STATE_DIR reads the new access.json, even inside the cache window', async () => {
    const prev = process.env.WECHAT_STATE_DIR
    try {
      process.env.WECHAT_STATE_DIR = dirWith(['first'])
      const { loadAccess, _clearCache } = await import('./access')
      _clearCache()
      expect(loadAccess().admins).toEqual(['first'])
      process.env.WECHAT_STATE_DIR = dirWith(['second'])
      expect(loadAccess().admins).toEqual(['second'])
    } finally {
      if (prev === undefined) delete process.env.WECHAT_STATE_DIR; else process.env.WECHAT_STATE_DIR = prev
    }
  })
})
