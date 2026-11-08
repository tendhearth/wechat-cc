import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskEnvironment } from './task-environment'
import { removeTempDir } from '../../lib/test-temp'

const dirs: string[] = []
const area = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'cc-task-env-'))); dirs.push(path); return path }
afterEach(() => dirs.splice(0).forEach(removeTempDir))

it('isolates task temp and Bun cache, reuses them on resume, and real child tools write inside the workspace', () => {
  const root = area()
  execFileSync('git',['init','-q'],{cwd:root})
  const env = taskEnvironment(root, 'abcd1234')
  expect(env).toEqual({ TMPDIR: join(root,'node_modules/.cache/cc-tasks/abcd1234/tmp'), TEMP: env.TMPDIR, TMP: env.TMPDIR, BUN_TMPDIR: env.TMPDIR, BUN_INSTALL_CACHE_DIR: join(root,'node_modules/.cache/cc-tasks/abcd1234/cache'), npm_config_cache: env.BUN_INSTALL_CACHE_DIR, GIT_CEILING_DIRECTORIES: env.TMPDIR })
  expect(taskEnvironment(root,'abcd1234')).toEqual(env)
  expect(taskEnvironment(root,'abcd1235').TMPDIR).not.toBe(env.TMPDIR)
  const path = execFileSync(process.execPath, ['-e', "process.stdout.write(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'test-')))"], { env: {...process.env,...env}, encoding: 'utf8' })
  expect(path.startsWith(env.TMPDIR!)).toBe(true)
  expect(existsSync(path)).toBe(true)
  expect(() => execFileSync('git',['rev-parse','--show-toplevel'],{cwd:path,env:{...process.env,...env},stdio:'pipe'})).toThrow()
})

it('refuses invalid task ids and repository symlinks before writing any external directory', () => {
  const root = area(), outside = area()
  expect(() => taskEnvironment(root,'../outside')).toThrow('invalid_task_environment')
  symlinkSync(outside, join(root,'node_modules'),'dir')
  expect(() => taskEnvironment(root,'abcd1234')).toThrow('invalid_task_environment')
  expect(existsSync(join(outside,'.cache'))).toBe(false)
  mkdirSync(join(outside,'kept'))
})
