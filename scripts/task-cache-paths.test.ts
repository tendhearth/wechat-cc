// @repo-guard Task caches must never become source inputs for repository checks.
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import base from '../vitest.config'
import node from '../vitest.node.config'
import e2e from '../vitest.e2e.config'
import evaluation from '../vitest.eval-engine.config'
import app from '../apps/app/vitest.config'
import { collectChanges, findShrinks, isSnapFile, isTestFile, isVitestConfig } from './test-shrink-lib'
import { scanInternalMocks } from './mock-internal-lib'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CACHE_ROOTS = ['.cc-tasks/task/cache', 'node_modules/.cache/cc-tasks/task']
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(): string { const dir = mkdtempSync(join(tmpdir(), 'task-source-inputs-')); dirs.push(dir); return dir }
function write(root: string, path: string, text = ''): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
function repository(files: Record<string, string>) {
  const dir = fixture()
  // Every git invocation is rooted in an initialized isolated repository; no shared refs or production config.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir), GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env, windowsHide: true })
    if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  for (const [path, text] of Object.entries(files)) write(dir, path, text)
  const commit = () => { git('add', '-f', '--all', '--', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD') }
  const initial = commit()
  return { dir, git, commit, initial, env }
}

it('recognizes only complete task-cache directory segments with either path separator', async () => {
  const { isTaskCachePath, repositorySourcePaths } = await import('./task-cache-paths')
  for (const separator of ['/', '\\']) {
    for (const cache of CACHE_ROOTS) {
      expect(isTaskCachePath(`src/${cache}/copy.test.ts`.replaceAll('/', separator))).toBe(true)
    }
    for (const source of ['src/task-cache.ts', 'src/.cc-tasks-old/a.ts', 'src/cc-tasks/a.ts', 'node_modules/.cache/cc-tasks-old/a.ts']) {
      expect(isTaskCachePath(source.replaceAll('/', separator))).toBe(false)
    }
  }
  expect(repositorySourcePaths(['src/real.ts', ...CACHE_ROOTS.map(path => `${path}/copy.test.ts`)] )).toEqual(['src/real.ts'])
})

describe('actual Vitest file collection', () => {
  it.each([
    ['base', base], ['node', node], ['e2e', e2e], ['evaluation', evaluation], ['app', app],
  ] as const)('%s keeps ordinary tests and drops both cache shapes', async (name, config) => {
    const { createVitest } = await import('vitest/node')
    const dir = fixture()
    const prefix = name === 'e2e' ? 'src/daemon/__e2e__' : 'src'
    const suffix = name === 'e2e' ? '.e2e.test.ts' : '.test.ts'
    const ordinary = `${prefix}/ordinary${suffix}`
    write(dir, ordinary)
    for (const cache of CACHE_ROOTS) write(dir, `${prefix}/${cache}/copied${suffix}`)
    // Only collect filenames; never execute the fixture tests or load an application's plugins.
    const ctx = await createVitest('test', {
      root: dir, config: false, watch: false, reporters: [],
      include: config.test?.include ?? ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
      exclude: config.test?.exclude ?? [],
    })
    try {
      const { testFiles } = await ctx.getRootProject().globTestFiles()
      expect(testFiles.map(path => relative(dir, path).replaceAll('\\', '/'))).toEqual([ordinary])
    } finally { await ctx.close() }
  })
})

it.each(['tsconfig.json', 'apps/mobile/tsconfig.json', 'apps/relay/tsconfig.json', 'apps/app/tsconfig.json'])('tsc excludes cache copies explicitly in %s', path => {
  const config = ts.readConfigFile(join(ROOT, path), ts.sys.readFile)
  expect(config.error).toBeUndefined()
  const dir = fixture()
  write(dir, 'src/ordinary.ts', 'export const value = 1')
  for (const cache of CACHE_ROOTS) write(dir, `src/${cache}/copied.ts`, 'const broken: never = 1')
  // Use the real configuration's exclude policy with a broad include to expose accidental collection.
  const parsed = ts.parseJsonConfigFileContent({ ...config.config, extends: undefined, compilerOptions: {}, include: ['**/*.ts'] }, ts.sys, dir)
  expect(parsed.errors).toEqual([])
  expect(parsed.fileNames.map(file => relative(dir, file).replaceAll('\\', '/'))).toEqual(['src/ordinary.ts'])
})

it('dependency-cruiser excludes both cache paths while retaining ordinary source', () => {
  const config = createRequire(import.meta.url)('../.dependency-cruiser.cjs')
  const exclude = new RegExp(config.options.exclude.path)
  expect(exclude.test('src/ordinary.ts')).toBe(false)
  for (const cache of CACHE_ROOTS) expect(exclude.test(`src/${cache}/copy.ts`)).toBe(true)
})

it('a real guard walk ignores cached violations and still reports ordinary violations', () => {
  const dir = fixture()
  const violation = ['vi', "mock('./internal', () => ({}))"].join('.')
  write(dir, 'src/ordinary.test.ts', violation)
  for (const cache of CACHE_ROOTS) write(dir, `${cache}/copied.test.ts`, violation)
  expect(scanInternalMocks(dir)).toEqual({ 'src/ordinary.test.ts': ['src/internal'] })
})

const assertion = "it('kept', () => { expect(1).toBe(1) })\n"
it.each(CACHE_ROOTS)('test-shrink ignores cached tests, snapshots and configs in %s', cache => {
  for (const separator of ['/', '\\']) {
    expect(isTestFile(`${cache}/a.test.ts`.replaceAll('/', separator))).toBe(false)
    expect(isSnapFile(`${cache}/a.test.ts.snap`.replaceAll('/', separator))).toBe(false)
    expect(isVitestConfig(`${cache}/vitest.config.ts`.replaceAll('/', separator))).toBe(false)
  }
  const repo = repository({
    'src/real.test.ts': assertion,
    [`${cache}/a.test.ts`]: assertion,
    [`${cache}/a.test.ts.snap`]: 'exports[`kept 1`] = `"one"`;\n',
    [`${cache}/vitest.config.ts`]: 'export default { test: { exclude: [] } }',
  })
  write(repo.dir, 'src/real.test.ts', '')
  write(repo.dir, `${cache}/a.test.ts`, '')
  write(repo.dir, `${cache}/a.test.ts.snap`, '')
  write(repo.dir, `${cache}/vitest.config.ts`, "export default { test: { exclude: ['src/real.test.ts'] } }")
  const head = repo.commit()
  const changes = collectChanges(repo.initial, head, repo.dir)
  expect(changes.map(change => change.headPath ?? change.basePath)).toEqual(['src/real.test.ts'])
  expect(findShrinks(changes)).toEqual([{ file: 'src/real.test.ts', what: '删掉了用例「kept」' }])
})

it.each(CACHE_ROOTS)('moving a real test into %s still counts as deletion', cache => {
  const repo = repository({ 'src/real.test.ts': assertion })
  mkdirSync(join(repo.dir, cache), { recursive: true })
  renameSync(join(repo.dir, 'src/real.test.ts'), join(repo.dir, cache, 'copied.test.ts'))
  const head = repo.commit()
  expect(collectChanges(repo.initial, head, repo.dir)).toEqual([{ basePath: 'src/real.test.ts', headPath: null, base: assertion, head: null }])
  expect(findShrinks(collectChanges(repo.initial, head, repo.dir))).toEqual([
    { file: 'src/real.test.ts', what: '删掉了整个测试文件,1 条用例没搬到别处(如「kept」)' },
  ])
})

it.each(CACHE_ROOTS)('moving a cached test out of %s counts as an addition', cache => {
  const repo = repository({ [`${cache}/copied.test.ts`]: assertion })
  mkdirSync(join(repo.dir, 'src'))
  renameSync(join(repo.dir, cache, 'copied.test.ts'), join(repo.dir, 'src/real.test.ts'))
  const head = repo.commit()
  const changes = collectChanges(repo.initial, head, repo.dir)
  expect(changes).toEqual([{ basePath: null, headPath: 'src/real.test.ts', base: null, head: assertion }])
  expect(findShrinks(changes)).toEqual([])
})

it.skipIf(process.platform === 'win32')('verify ignores forcibly tracked cache changes when only Markdown source changed', () => {
  const found = spawnSync('which', ['bun'], { encoding: 'utf8', windowsHide: true })
  expect(found.status).toBe(0)
  const bun = process.versions.bun ? process.execPath : realpathSync(found.stdout.trim())
  const files: Record<string, string> = { 'README.md': 'before\n', '.gitignore': 'bin/\n.cc-tasks/\nnode_modules/\n' }
  for (const cache of CACHE_ROOTS) files[`${cache}/copied.test.ts`] = assertion
  const repo = repository(files)
  write(repo.dir, 'README.md', 'after\n')
  for (const cache of CACHE_ROOTS) write(repo.dir, `${cache}/copied.test.ts`, '')
  write(repo.dir, 'bin/bun', '#!/bin/sh\nprintf "UNEXPECTED_TEST_COMMAND\\n"\nexit 0\n')
  // Only subprocess commands are intercepted. The verify script and git collectors are the real implementation.
  const { chmodSync } = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')
  chmodSync(join(repo.dir, 'bin/bun'), 0o755)
  const result = spawnSync(bun, [join(ROOT, 'scripts/verify.ts'), '--base', 'HEAD'], {
    cwd: repo.dir, encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...repo.env, PATH: `${join(repo.dir, 'bin')}:${process.env.PATH}` },
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('只改了 Markdown(1 个文件)')
  expect(result.stdout).not.toContain('UNEXPECTED_TEST_COMMAND')
})
