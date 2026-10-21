// src/daemon/__e2e__/boot-failure-lock.e2e.test.ts
// 启动失败 ⇒ bootDaemon 抛错时实例锁(server.pid)已经放掉(重构第二批步 6a,wechat-cc-2a 评审):
// main() 在退出前要指数退避等上几十秒到 30 分钟,这段时间里锁要是还拿着,self deploy 回滚拉起的老 sidecar
// 抢不到锁,用户手动 start 也会看到「已经在跑了」。故障注入在 try 之前:数据库文件位置是个目录 ⇒ openDb 抛错
// (迁移失败、库坏了是同一类确定性失败)。
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function seed(): string {
  const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-bootfail-'))
  mkdirSync(join(stateDir, 'accounts', 'bot1'), { recursive: true })
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ allowFrom: ['*'], admins: ['testadmin'] }))
  writeFileSync(join(stateDir, 'accounts', 'bot1', 'account.json'), JSON.stringify({ botId: 'bot1', userId: 'owner1', baseUrl: 'http://127.0.0.1:9' }))
  writeFileSync(join(stateDir, 'accounts', 'bot1', 'token'), 'fake-token')
  return stateDir
}

describe('e2e: boot failure releases the instance lock before main() backs off', () => {
  it.each([
    ['openDb throws (db path is a directory)', (d: string) => mkdirSync(join(d, 'wechat-cc.db'))],
    ['access.json corrupt (used to process.exit and skip the backoff)', (d: string) => writeFileSync(join(d, 'access.json'), '{not json')],
  ])('%s ⇒ bootDaemon rejects and server.pid is gone', async (_name, breakIt) => {
    const stateDir = seed(); breakIt(stateDir)
    const prev = { a: process.env.WECHAT_CC_STATE_DIR, b: process.env.WECHAT_STATE_DIR }
    process.env.WECHAT_CC_STATE_DIR = stateDir; process.env.WECHAT_STATE_DIR = stateDir
    try {
      const { bootDaemon } = await import('../main')
      await expect(bootDaemon({ stateDir, dangerously: false })).rejects.toThrow()
      expect(existsSync(join(stateDir, 'server.pid'))).toBe(false)
    } finally {
      if (prev.a === undefined) delete process.env.WECHAT_CC_STATE_DIR; else process.env.WECHAT_CC_STATE_DIR = prev.a
      if (prev.b === undefined) delete process.env.WECHAT_STATE_DIR; else process.env.WECHAT_STATE_DIR = prev.b
    }
  })
})
