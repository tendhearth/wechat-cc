import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SOURCE_REPO_ROOT, CLI_ENTRY } from './repo-root'

// 2026-09-27 cli 拆分:self / hook / service / update 四族原来在根 cli.ts 里用
// `dirname(fileURLToPath(import.meta.url))` 当仓库根;搬进 src/cli/commands/ 后同一表达式
// 指向别处。四处统一从这里取,这条测试钉住它真的指向仓库根。
describe('repo-root(源码模式下的仓库根)', () => {
  it('SOURCE_REPO_ROOT 是这个仓库的根(有 package.json 且名字对)', () => {
    const pkg = JSON.parse(readFileSync(join(SOURCE_REPO_ROOT, 'package.json'), 'utf8')) as { name?: string }
    expect(pkg.name).toBe('claude-channel-wechat')
  })
  it('CLI_ENTRY 是根目录的 cli.ts', () => {
    expect(CLI_ENTRY).toBe(join(SOURCE_REPO_ROOT, 'cli.ts'))
    expect(existsSync(CLI_ENTRY)).toBe(true)
  })
})
