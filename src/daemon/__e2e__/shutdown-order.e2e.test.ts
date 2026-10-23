// 关机顺序快照(核心链进模块容器的 PR 0,设计稿 docs/superpowers/specs/2026-10-23-core-chain-modules-design.md)。
//
// 起真的 daemon(bootDaemon,假 ilink),正常关掉,从 channel.log 里按先后读出每一步「停了谁」:
// LifecycleSet 的 `[LIFECYCLE] stopped <name>` 与模块容器的 `[MODULES] stopped <module>/<reg>`。
// 以后核心五样一样一样搬进容器,这份快照的 diff 就是关机顺序的变化 —— 逐行讲得出为什么才能 -u,
// 跟命令路由快照同一个规矩。只加测试,不改行为。
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestDaemon } from './harness'

const STOP_LINE = /\[(LIFECYCLE|MODULES)\] stopped (\S+)/

describe('daemon shutdown order (snapshot)', () => {
  it('stops every subsystem in the recorded order', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-shutdown-order-'))
    try {
      const daemon = await startTestDaemon({ stateDirOverride: stateDir })
      await daemon.stop()
      const order = readFileSync(join(stateDir, 'channel.log'), 'utf8').split('\n')
        .map(l => STOP_LINE.exec(l)).filter((m): m is RegExpExecArray => m !== null)
        .map(m => `${m[1] === 'MODULES' ? 'module' : 'lc'} ${m[2]}`)
      // 核心五样都在、各停一次 —— 快照之外先把这条钉死,免得有人整份 -u 把漏掉的也认了
      for (const core of ['internal-api', 'workbench', 'sessions', 'ilink', 'polling']) {
        expect(order.filter(s => s === `lc ${core}`), core).toHaveLength(1)
      }
      expect(order).toMatchSnapshot()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 30_000)
})
