// src/daemon/__e2e__/boot-failure-lock.e2e.test.ts
// 启动失败 ⇒ bootDaemon 抛错时实例锁(server.pid)已经放掉(重构第二批步 6a,wechat-cc-2a 评审):
// main() 在退出前要指数退避等上几十秒到 30 分钟,这段时间里锁要是还拿着,self deploy 回滚拉起的老 sidecar
// 抢不到锁,用户手动 start 也会看到「已经在跑了」。故障注入在 try 之前:数据库文件位置是个目录 ⇒ openDb 抛错
// (迁移失败、库坏了是同一类确定性失败)。
import { afterEach, beforeAll, describe, it, expect } from 'vitest'
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
  // 冷启动 import 整个 daemon 在满载下能超过 10s:放在 beforeAll(给足时间)里只付一次,不算进第一条用例(10-21 假红)。
  let bootDaemon: typeof import('../main')['bootDaemon']
  beforeAll(async () => { ({ bootDaemon } = await import('../main')) }, 60_000)
  // 环境变量在 afterEach 里还原,不在用例自己的 finally 里:上一条超时以后它的 bootDaemon 还在后台跑,迟到的 finally
  // 会在下一条用例启动途中把 WECHAT_STATE_DIR 改回去 —— 下一条就读到默认目录里根本不存在的 access.json,启动「成功」了(10-21 实见)。
  const prev = { a: process.env.WECHAT_CC_STATE_DIR, b: process.env.WECHAT_STATE_DIR }
  afterEach(() => {
    if (prev.a === undefined) delete process.env.WECHAT_CC_STATE_DIR; else process.env.WECHAT_CC_STATE_DIR = prev.a
    if (prev.b === undefined) delete process.env.WECHAT_STATE_DIR; else process.env.WECHAT_STATE_DIR = prev.b
  })
  it.each([
    ['openDb throws (db path is a directory)', (d: string) => mkdirSync(join(d, 'wechat-cc.db'))],
    ['access.json corrupt (used to process.exit and skip the backoff)', (d: string) => writeFileSync(join(d, 'access.json'), '{not json')],
  ])('%s ⇒ bootDaemon rejects and server.pid is gone', async (_name, breakIt) => {
    const stateDir = seed(); breakIt(stateDir)
    process.env.WECHAT_CC_STATE_DIR = stateDir; process.env.WECHAT_STATE_DIR = stateDir
    await expect(bootDaemon({ stateDir, dangerously: false })).rejects.toThrow()
    expect(existsSync(join(stateDir, 'server.pid'))).toBe(false)
  }, 30_000)
})
