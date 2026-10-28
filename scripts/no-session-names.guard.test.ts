/**
 * 仓库里不写协作会话的名字(2026-10-23)。
 *
 * 两路开发时,会话叫 wechat-cc-9d / arch-review 之类;这些名字只在那一晚的终端里有意义,写进注释、设计稿、测试标题,
 * 半年后读的人(包括 CC 自己)不知道是谁。写角色:「整合者」「审查者」,要追溯就写 PR 号(「整合者评审 #541」)。
 * 一次清掉 50 个文件后上的守卫;以后换了会话名,把新名字加进下面的表。
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SESSION_NAMES = String.raw`wechat-cc-9d|(^|[^0-9A-Za-z])9d([^0-9A-Za-z]|$)|arch-review`
// 本文件自己要写这些名字。
const SELF = 'scripts/no-session-names.guard.test.ts'

describe('仓库里不写协作会话的名字', () => {
  it('docs / src / scripts / AGENTS.md 里没有', () => {
    const r = spawnSync('git', ['grep', '-nE', SESSION_NAMES, '--', 'docs/*.md', 'src/*', 'scripts/*', 'AGENTS.md', `:!${SELF}`], { cwd: ROOT, encoding: 'utf8' })
    // git grep:0 = 有命中,1 = 没有,其余 = 出错(出错不能当成「没有」)。
    expect(r.status === 0 || r.status === 1, r.stderr).toBe(true)
    expect(r.stdout.trim(), '写角色(整合者 / 审查者)+ PR 号,别写会话名').toBe('')
  })
})
