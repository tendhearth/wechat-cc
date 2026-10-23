/**
 * scripts/migration-frozen.ts 的行为(第三批 3e):在一个临时 git 仓库里造出 origin/dev,逐种情况跑脚本看退出码。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'migration-frozen.ts')
// 脚本是 .ts,CI 里用 bun 跑;node 下跑这条测试时也用 PATH 上的 bun 去执行它,没有 bun 才跳过。
const BUN = process.versions.bun ? process.execPath : 'bun'
const HAVE_BUN = spawnSync(BUN, ['--version'], { encoding: 'utf8' }).status === 0
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'mig-frozen-')); dirs.push(d)
  const g = (...a: string[]) => { const r = spawnSync('git', a, { cwd: d, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr) }
  g('init', '-q', '-b', 'dev'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false')
  mkdirSync(join(d, 'src/lib/db/migrations'), { recursive: true })
  writeFileSync(join(d, 'src/lib/db/migrations/v001.ts'), 'export const migration = 1\n')
  writeFileSync(join(d, 'src/lib/db/migrations/v002.ts'), 'export const migration = 2\n')
  g('add', '-A'); g('commit', '-q', '-m', 'base')
  g('update-ref', 'refs/remotes/origin/dev', 'HEAD')
  return d
}
const run = (cwd: string, env: Record<string, string> = {}) =>
  spawnSync(BUN, [SCRIPT], { cwd, encoding: 'utf8', env: { ...process.env, CI: 'false', PR_TITLE: '', ...env } })

describe.skipIf(!HAVE_BUN)('migration-frozen', () => {
  it('passes when every migration already on dev is unchanged and a new one is added', () => {
    const d = repo()
    writeFileSync(join(d, 'src/lib/db/migrations/v003.ts'), 'export const migration = 3\n')
    expect(run(d).status).toBe(0)
  })
  it.each([
    ['edited', (d: string) => writeFileSync(join(d, 'src/lib/db/migrations/v001.ts'), 'export const migration = 99\n')],
    ['deleted', (d: string) => rmSync(join(d, 'src/lib/db/migrations/v002.ts'))],
  ])('fails when a migration already on dev is %s', (_why, mutate) => {
    const d = repo(); mutate(d)
    const r = run(d)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('已经进了 dev')
  })
  it('the [migration-edit] title lets an edit through, and lists what changed', () => {
    const d = repo()
    writeFileSync(join(d, 'src/lib/db/migrations/v001.ts'), 'export const migration = 99\n')
    const r = run(d, { PR_TITLE: '修 v001 的笔误 [migration-edit]' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('src/lib/db/migrations/v001.ts')
  })
  it('a title that tries shell tricks is just text (read from env, never evaluated)', () => {
    const d = repo()
    writeFileSync(join(d, 'src/lib/db/migrations/v001.ts'), 'export const migration = 99\n')
    expect(run(d, { PR_TITLE: '$(touch pwned) `touch pwned2`' }).status).toBe(1)
  })
  it('without origin/dev: skips locally, but fails on CI', () => {
    const d = repo()
    spawnSync('git', ['update-ref', '-d', 'refs/remotes/origin/dev'], { cwd: d })
    expect(run(d).status).toBe(0)
    const ci = run(d, { CI: 'true' })
    expect(ci.status).toBe(1)
    expect(ci.stderr).toContain('不能悄悄跳过')
  })
})
