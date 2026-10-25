/**
 * vitest.config.ts 里按平台排除的测试文件,写的是字符串路径 —— 搬文件的 codemod 只改 import,不改它。
 * 2026-10-25:E2 把 codex / claude / acp 适配器搬进 src/adapters/executors 后,win32 排除名单整段失效,
 * Windows CI 红了一片(PR 上不跑 Windows,合进 dev 才看见)。这里钉住:名单里每一项都得是真有的文件。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
const listed = [...config.matchAll(/'((?:src|apps|packages|scripts)\/[^'*]+\.test\.ts)'/g)].map(m => m[1]!)

describe('vitest.config.ts 排除的测试文件都还在', () => {
  it('扫到了(win32 那段)', () => { expect(listed.length).toBeGreaterThan(5) })
  it.each(listed)('%s', path => { expect(existsSync(join(ROOT, path)), `${path} 不存在:搬过家就改这里的路径`).toBe(true) })
})
