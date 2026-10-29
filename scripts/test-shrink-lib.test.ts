/**
 * 测试缩水检查(scripts/test-shrink-lib.ts / test-shrink-check.ts)自己的测试。
 * 前半是纯逻辑(拿两版测试文件的文本比),后半在临时 git 仓库里按 CI 的样子(GITHUB_EVENT_NAME=pull_request)跑 CLI 看退出码。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { analyzeTestFile, excludeEntries, findShrinks, judge, looksLikeFix, section, snapshotKeys, unexplained, type FileChange } from './test-shrink-lib'

const BASE_TEST = `import { describe, it, expect } from 'vitest'
describe('adder', () => {
  it('adds two numbers', () => {
    expect(add(1, 2)).toBe(3)
    expect(add(0, 0)).toBe(0)
  })
  it("handles negatives", () => {
    expect(add(-1, -2)).toEqual(-3)
  })
  it(\`keeps \${'templates'} intact\`, () => {
    const re = /\\(it\\(/  // 正则和注释里的 it( 不算
    expect(re.test('it(')).toBe(true)
  })
  it.each([[1], [2]])('table %s', (n) => {
    expect(n).toHaveLength(1)
  })
})
`
const mod = (path: string, base: string, head: string): FileChange => ({ basePath: path, headPath: path, base, head })

describe('analyzeTestFile', () => {
  it('数出用例、每条的 expect 与精确断言;字符串 / 正则 / 注释里的 it( 不算', () => {
    const f = analyzeTestFile(BASE_TEST)
    expect(f.cases.map(c => c.title)).toEqual(['adds two numbers', 'handles negatives', "`keeps ${'templates'} intact`", 'table %s'])
    expect(f.cases.map(c => c.expects)).toEqual([2, 1, 1, 1])
    expect(f.cases.map(c => c.exact)).toEqual([2, 1, 1, 1])
    expect(f.skips).toBe(0)
    expect(f.only).toBe(0)
  })
  it('skip / skipIf / todo / only(it、describe 上都算),ctx.skip() 也算;regex.test( 不是用例', () => {
    const f = analyzeTestFile(`describe.skipIf(win)('x', () => { it.skip('a', () => {}); it.todo('b'); it.only('c', () => { if (/x/.test(s)) ctx.skip() }) })`)
    expect(f.cases.map(c => c.title)).toEqual(['a', 'b', 'c'])
    expect(f.skips).toBe(4)
    expect(f.only).toBe(1)
  })
  it('expect.soft / expect.poll / assert.* 算断言,expect.any / objectContaining 不算', () => {
    const f = analyzeTestFile(`it('t', () => { expect.soft(a).toBe(1); expect.poll(() => b).toBe(2); assert.equal(c, 3); expect(d).toEqual(expect.objectContaining({ x: expect.any(Number) })) })`)
    expect(f.cases[0]).toEqual({ title: 't', expects: 4, exact: 3 })
  })
})

describe('findShrinks —— 该报的', () => {
  it('删掉一条用例', () => {
    const head = BASE_TEST.replace(/  it\("handles negatives"[\s\S]*?\n  \}\)\n/, '')
    expect(findShrinks([mod('a.test.ts', BASE_TEST, head)])).toEqual([{ file: 'a.test.ts', what: '删掉了用例「handles negatives」' }])
  })
  it('删掉一个 expect', () => {
    const head = BASE_TEST.replace('    expect(add(0, 0)).toBe(0)\n', '')
    const f = findShrinks([mod('a.test.ts', BASE_TEST, head)])
    expect(f).toHaveLength(1)
    expect(f[0]!.what).toContain('「adds two numbers」的断言从 2 个变成 1 个')
  })
  it('toBe(3) 改成 toBeDefined()(断言个数不变,但放松了)', () => {
    const head = BASE_TEST.replace('expect(add(1, 2)).toBe(3)', 'expect(add(1, 2)).toBeDefined()')
    const f = findShrinks([mod('a.test.ts', BASE_TEST, head)])
    expect(f).toHaveLength(1)
    expect(f[0]!.what).toContain('精确断言')
  })
  it('toHaveLength(1) 改成 toBeTruthy()', () => {
    const head = BASE_TEST.replace('toHaveLength(1)', 'toBeTruthy()')
    expect(findShrinks([mod('a.test.ts', BASE_TEST, head)]).map(f => f.what)).toEqual([expect.stringContaining('「table %s」的精确断言')])
  })
  it('加了 .skip、加了 .only', () => {
    expect(findShrinks([mod('a.test.ts', BASE_TEST, BASE_TEST.replace("it(\"handles", "it.skip(\"handles"))]).map(f => f.what))
      .toEqual([expect.stringContaining('从 0 处变成 1 处')])
    expect(findShrinks([mod('a.test.ts', BASE_TEST, BASE_TEST.replace("describe('adder'", "describe.only('adder'"))]).map(f => f.what))
      .toEqual(['新加了 .only(其余用例全被跳过)'])
  })
  it('删掉整个测试文件(用例没搬到别处):合成一条', () => {
    const f = findShrinks([{ basePath: 'a.test.ts', headPath: null, base: BASE_TEST, head: null }])
    expect(f).toEqual([{ file: 'a.test.ts', what: '删掉了整个测试文件,4 条用例没搬到别处(如「adds two numbers」)' }])
  })
  it('快照少了一条', () => {
    const snap = (keys: string[]) => `// Vitest Snapshot v1\n\n${keys.map(k => `exports[\`${k}\`] = \`"x"\`;\n`).join('\n')}`
    expect(snapshotKeys(snap(['a 1', 'b 1']))).toEqual(['a 1', 'b 1'])
    const f = findShrinks([mod('__snapshots__/a.test.ts.snap', snap(['a 1', 'b 1']), snap(['a 1']))])
    expect(f).toEqual([{ file: '__snapshots__/a.test.ts.snap', what: '快照少了「b 1」' }])
  })
  it('vitest 配置的 exclude 多了一项', () => {
    const base = `export default { test: { exclude: ['**/node_modules/**', ...(win ? ['a.test.ts'] : [])] } }`
    const head = base.replace("['a.test.ts']", "['a.test.ts', 'b.test.ts']")
    expect(excludeEntries(base)).toBe(2)
    expect(findShrinks([mod('vitest.config.ts', base, head)])).toEqual([{ file: 'vitest.config.ts', what: 'exclude 多了 1 项(被排除的测试不再跑)' }])
  })
})

describe('findShrinks —— 不该报的', () => {
  it('git 认出的改名,用例一样', () => {
    expect(findShrinks([{ basePath: 'old/a.test.ts', headPath: 'new/a.test.ts', base: BASE_TEST, head: BASE_TEST }])).toEqual([])
  })
  it('没认出改名(删 + 加),用例原样搬过去', () => {
    expect(findShrinks([
      { basePath: 'old/a.test.ts', headPath: null, base: BASE_TEST, head: null },
      { basePath: null, headPath: 'new/a.test.ts', base: null, head: BASE_TEST },
    ])).toEqual([])
  })
  it('一个文件拆成两个', () => {
    const [first, second] = BASE_TEST.split("  it(\"handles negatives\"")
    expect(findShrinks([
      mod('a.test.ts', BASE_TEST, `${first}})\n`),
      { basePath: null, headPath: 'b.test.ts', base: null, head: `describe('x', () => {\n  it("handles negatives"${second}` },
    ])).toEqual([])
  })
  it('只改了用例标题', () => {
    expect(findShrinks([mod('a.test.ts', BASE_TEST, BASE_TEST.replace('adds two numbers', 'adds 2 numbers'))])).toEqual([])
  })
  it('加用例、加断言、把 toBeDefined 收紧成 toBe', () => {
    const head = BASE_TEST.replace('expect(add(0, 0)).toBe(0)', 'expect(add(0, 0)).toBe(0)\n    expect(add(2, 2)).toBe(4)') + `it('new', () => { expect(1).toBe(1) })\n`
    expect(findShrinks([mod('a.test.ts', BASE_TEST, head)])).toEqual([])
  })
  it('新加的测试文件、快照里多了条目', () => {
    expect(findShrinks([{ basePath: null, headPath: 'n.test.ts', base: null, head: BASE_TEST.replace("it(\"handles", "it.skipIf(win)(\"handles") }])).toEqual([])
  })
})

describe('PR 描述', () => {
  const body = `## 改了啥\n删了旧功能\n\n## 删掉/放松的测试\n<!-- 每个文件一行 -->\n- \`src/a.test.ts\`:功能整个删了\n- b.test.ts\n\n## 红/绿\n<!-- 模板注释不算内容 -->\n`
  it('section:取到下一个标题为止,去掉 HTML 注释;空的(只剩模板注释)当没写', () => {
    expect(section(body, '删掉/放松的测试')).toBe('- `src/a.test.ts`:功能整个删了\n- b.test.ts')
    expect(section(body, '红/绿')).toBe('')
    expect(section('## 别的', '红/绿')).toBeNull()
  })
  it('unexplained:全路径或文件名都认,但那一行要有理由', () => {
    expect(unexplained(['src/a.test.ts', 'src/b.test.ts', 'c.test.ts'], section(body, '删掉/放松的测试')!)).toEqual(['src/b.test.ts', 'c.test.ts'])
  })
  it('looksLikeFix:fix/ 分支、fix / 修 开头的标题;「修改」「修订」不算', () => {
    expect(looksLikeFix('任意', 'fix/x')).toBe(true)
    expect(looksLikeFix('fix(ci): x', 'claude/x')).toBe(true)
    expect(looksLikeFix('修:重启丢消息', 'claude/x')).toBe(true)
    expect(looksLikeFix('修复重启丢消息', 'claude/x')).toBe(true)
    expect(looksLikeFix('修改文案', 'claude/x')).toBe(false)
    expect(looksLikeFix('fixture 换路径', 'claude/x')).toBe(false)
    expect(looksLikeFix('自改 #12:修个错字', 'self/12')).toBe(false)
  })
  it('judge:有缩水没写理由 ⇒ 红;修 bug 没 红/绿 ⇒ 红;都写了 ⇒ 绿', () => {
    const findings = [{ file: 'src/a.test.ts', what: 'x' }]
    expect(judge(findings, { title: 't', body: '', headRef: 'claude/x' }).ok).toBe(false)
    expect(judge(findings, { title: 't', body, headRef: 'claude/x' }).ok).toBe(true)
    expect(judge([], { title: '修:x', body, headRef: 'claude/x' }).ok).toBe(false)
    expect(judge([], { title: '修:x', body: `${body}bun x vitest run a.test.ts:撤掉修复红 1 条,带上修复绿\n`, headRef: 'claude/x' }).ok).toBe(true)
    expect(judge([], { title: '加功能', body: '', headRef: 'claude/x' })).toEqual({ ok: true, messages: [] })
  })

  it('dev → master 的发版 PR 不查(dev 上每个 PR 都查过);别的分支进 master、进 dev 照查', () => {
    const findings = [{ file: 'src/a.test.ts', what: '删掉了用例「x」' }]
    expect(judge(findings, { title: '发版 desktop v9.9.9', body: '', headRef: 'dev', baseRef: 'master' }).ok).toBe(true)
    expect(judge(findings, { title: '发版 desktop v9.9.9', body: '', headRef: 'dev', baseRef: 'dev' }).ok).toBe(false)
    expect(judge(findings, { title: 'hotfix', body: '', headRef: 'claude/x', baseRef: 'master' }).ok).toBe(false)
    expect(judge([], { title: '修:x', body: '', headRef: 'fix/x', baseRef: 'master' }).ok).toBe(false)
    expect(judge(findings, { title: 't', body: '', headRef: 'claude/x' }).ok).toBe(false)
  })
})

// ───────────────────────── CLI:临时 git 仓库里按 CI 的样子跑 ─────────────────────────

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'test-shrink-check.ts')
const BUN = process.versions.bun ? process.execPath : 'bun'
const HAVE_BUN = spawnSync(BUN, ['--version'], { encoding: 'utf8' }).status === 0
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function repo(): { d: string; commit: (msg: string) => void } {
  const d = mkdtempSync(join(tmpdir(), 'test-shrink-')); dirs.push(d)
  const g = (...a: string[]) => { const r = spawnSync('git', a, { cwd: d, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr) }
  g('init', '-q', '-b', 'dev'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false')
  mkdirSync(join(d, 'src'))
  writeFileSync(join(d, 'src/a.test.ts'), BASE_TEST)
  g('add', '-A'); g('commit', '-q', '-m', 'base')
  g('update-ref', 'refs/remotes/origin/dev', 'HEAD')
  g('checkout', '-q', '-b', 'feature')
  return { d, commit: (msg: string) => { g('add', '-A'); g('commit', '-q', '-m', msg) } }
}
const runPr = (cwd: string, pr: { title?: string; body?: string; head?: string }) =>
  spawnSync(BUN, [SCRIPT], {
    cwd, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'dev', GITHUB_HEAD_REF: pr.head ?? 'claude/x', PR_TITLE: pr.title ?? '加功能', PR_BODY: pr.body ?? '' },
  })

describe.skipIf(!HAVE_BUN)('test-shrink-check(CLI,PR 模式)', () => {
  it('改名搬家、用例一样 ⇒ 绿', () => {
    const { d, commit } = repo()
    mkdirSync(join(d, 'src/features'))
    renameSync(join(d, 'src/a.test.ts'), join(d, 'src/features/a.test.ts'))
    commit('move')
    const r = runPr(d, {})
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
  it('删一条断言、描述里没写 ⇒ 红,点名文件;写了理由 ⇒ 绿', () => {
    const { d, commit } = repo()
    writeFileSync(join(d, 'src/a.test.ts'), BASE_TEST.replace('    expect(add(0, 0)).toBe(0)\n', ''))
    commit('shrink')
    const red = runPr(d, { body: '## 改了啥\nx' })
    expect(red.status).toBe(1)
    expect(red.stdout).toContain('「adds two numbers」的断言从 2 个变成 1 个')
    expect(red.stderr).toContain('  - src/a.test.ts')
    expect(runPr(d, { body: '## 删掉/放松的测试\n- src/a.test.ts:add(0,0) 那条跟上一条重复' }).status).toBe(0)
  })
  it('fix/ 分支没有 ## 红/绿 ⇒ 红;有 ⇒ 绿', () => {
    const { d, commit } = repo()
    writeFileSync(join(d, 'src/a.ts'), 'export const x = 1\n')
    commit('fix')
    const red = runPr(d, { head: 'fix/thing' })
    expect(red.status).toBe(1)
    expect(red.stderr).toContain('## 红/绿')
    expect(runPr(d, { head: 'fix/thing', body: '## 红/绿\n撤掉修复:`bun x vitest run src/a.test.ts` 1 failed;带上:passed' }).status).toBe(0)
  })
  it('本机(不在 PR 里)只报告,退出 0', () => {
    const { d, commit } = repo()
    rmSync(join(d, 'src/a.test.ts'))
    commit('delete')
    const r = spawnSync(BUN, [SCRIPT], { cwd: d, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: '' } })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('删掉了整个测试文件')
  })
})
