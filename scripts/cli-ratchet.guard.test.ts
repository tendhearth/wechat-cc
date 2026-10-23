/**
 * cli.ts 的**棘轮守卫**(2026-09-27,梳理第 3 步)。
 *
 * 根 cli.ts 是 4332 行、127 个 defineCommand 的命令树,动态 import src/daemon 内部
 * 39 处。depcruise 的 cli-must-not-depend-on-daemon 只管 ^src/cli/,根文件不受约束。
 * 拆它是梳理第 7 步的事;这一步先钉住「不再增长」:daemon 动态 import 数只许降(行数上限 10-22 删了,见下)。
 * 下沉一个命令后把这两个上限往下调 —— 棘轮只往一个方向转。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'cli.ts'), 'utf8')

// 行数上限已删(3f,2026-10-22,理念 5「数违规条数,不数行数」):它把代码挤成一行两千字符(service.ts 的 ctx 那行 2133 字符),
// 量的是症状。留下的是结构上的数:链接 daemon 的次数。新命令照旧去 src/cli/<group>.ts,cli.ts 只登记。
const MAX_DAEMON_IMPORTS = 38

describe('cli.ts 只许变小', () => {
  it(`整个 CLI(cli.ts + src/cli/commands/**)链接 src/daemon 的次数 ≤ ${MAX_DAEMON_IMPORTS}(cli 应 spawn daemon,不链接它)`, () => {
    // 第二把尺(spec 2026-09-27-cli-split §2):命令体从 cli.ts 搬进 src/cli/commands/ 时把 daemon
    // 动态 import 一起带过去,depcruise 对 commands/ 降成 warn;总数由这里钉住只降不升。
    // 真正解耦(改走内部 API / src/core)另立项;这里只让耦合可见、可量。
    let n = (src.match(/import\('\.\/src\/daemon\//g) ?? []).length
    const dir = join(ROOT, 'src', 'cli', 'commands')
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
        const body = readFileSync(join(dir, f), 'utf8')
        n += (body.match(/import\('\.\.\/\.\.\/daemon\//g) ?? []).length
        n += (body.match(/from '\.\.\/\.\.\/daemon\//g) ?? []).length
      }
    }
    expect(n).toBeLessThanOrEqual(MAX_DAEMON_IMPORTS)
  })
})
