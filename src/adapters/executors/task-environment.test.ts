import { afterEach, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { commitWorktree } from '../git/worktree-workspaces'
import { takeCheckpoint } from '../../features/workbench/checkpoints'
import { captureGitBaseline, finishGitReview } from '../../features/workbench/git-review'
import { taskEnvironment } from './task-environment'
import { removeTempDir } from '../../lib/test-temp'

const dirs: string[] = []
const area = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'cc-task-env-'))); dirs.push(path); return path }
afterEach(() => dirs.splice(0).forEach(removeTempDir))

it('isolates task temp and Bun cache, reuses them on resume, and real child tools write inside the workspace', async () => {
  const root = area()
  execFileSync('git',['init','-q'],{cwd:root})
  const env = (await taskEnvironment(root, 'abcd1234'))
  expect(env).toEqual({ TMPDIR: join(root,'.cc-tasks/abcd1234/tmp'), TEMP: env.TMPDIR, TMP: env.TMPDIR, BUN_TMPDIR: env.TMPDIR, BUN_INSTALL_CACHE_DIR: join(root,'.cc-tasks/abcd1234/cache'), npm_config_cache: env.BUN_INSTALL_CACHE_DIR, GIT_CEILING_DIRECTORIES: env.TMPDIR })
  expect((await taskEnvironment(root,'abcd1234'))).toEqual(env)
  expect((await taskEnvironment(root,'abcd1235')).TMPDIR).not.toBe(env.TMPDIR)
  const path = execFileSync(process.execPath, ['-e', "process.stdout.write(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'test-')))"], { env: {...process.env,...env}, encoding: 'utf8' })
  expect(path.startsWith(env.TMPDIR!)).toBe(true)
  expect(existsSync(path)).toBe(true)
  expect(() => execFileSync('git',['rev-parse','--show-toplevel'],{cwd:path,env:{...process.env,...env},stdio:'pipe'})).toThrow()
})

it('refuses invalid task ids and repository symlinks before writing any external directory', async () => {
  const root = area(), outside = area()
  await expect(taskEnvironment(root,'../outside')).rejects.toThrow('invalid_task_environment')
  symlinkSync(outside, join(root,'.cc-tasks'),'dir')
  await expect(taskEnvironment(root,'abcd1234')).rejects.toThrow('invalid_task_environment')
  expect(existsSync(join(outside,'.cache'))).toBe(false)
  mkdirSync(join(outside,'kept'))
})


it('[P2-7] ignores runtime in a non-Node repository, commits, checkpoints and review, even after force-staging', async () => {
  const root=area(), stateDir=area()
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim()
  git('init','-q');git('config','user.email','fixture@localhost');git('config','user.name','Fixture')
  writeFileSync(join(root,'readme.txt'),'base');git('add','.');git('commit','-qm','base')
  const baseline=await captureGitBaseline(root)
  const env=await taskEnvironment(root,'abcd1234')
  writeFileSync(join(env.TMPDIR!,'tool.log'),'private scratch');writeFileSync(join(env.npm_config_cache!,'cache.log'),'cache')
  // Check the exit status, not Git's platform-dependent quoted path output.
  expect(git('check-ignore','--quiet','--',join(env.TMPDIR!,'tool.log'))).toBe('')
  expect(git('status','--porcelain','--untracked-files=all')).toBe('')
  writeFileSync(join(root,'readme.txt'),'changed')
  const result=commitWorktree(root,'change')
  expect(result.committed).toBe(true)
  expect(git('ls-tree','-r','--name-only','HEAD')).toBe('readme.txt')
  // Explicit exclusions also protect checkpoint's copied index and review path budgets.
  git('add','-f','.cc-tasks')
  const point=await takeCheckpoint({root,taskId:'abcd1234',stateDir})
  expect(point).toHaveProperty('commit')
  if(!('commit' in point))throw Error('checkpoint missing')
  expect(git('ls-tree','-r','--name-only',point.commit)).toBe('readme.txt')
  const review=await finishGitReview(baseline)
  expect(review?.files.map(f=>f.path)).toEqual(['readme.txt'])
  expect(review?.preexistingPaths).toEqual([])
  expect(()=>commitWorktree(root,'no runtime')).toThrow('invalid_task_environment')
  await expect(taskEnvironment(root,'abcd1235')).rejects.toThrow('invalid_task_environment')
})

it('[P2-8] the same task can run tools and use its cache after a real offline npm ci', async () => {
  const root=area(), user=area(), run=promisify(execFile)
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'task-fixture',version:'1.0.0'}))
  writeFileSync(join(root,'package-lock.json'),JSON.stringify({name:'task-fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'task-fixture',version:'1.0.0'}}}))
  const env=await taskEnvironment(root,'abcd1234')
  writeFileSync(join(env.BUN_INSTALL_CACHE_DIR!,'kept'),'cache')
  const result=await run('npm',['ci','--ignore-scripts','--offline','--no-audit','--no-fund','--userconfig='+join(user,'empty-npmrc'),'--globalconfig='+join(user,'global-npmrc')],{cwd:root,env:{...process.env,...env,HOME:user},timeout:10_000})
  expect(result.stderr).not.toContain('ERR!')
  const next=mkdtempSync(join(env.TMPDIR!,'after-ci-'))
  expect(existsSync(next)).toBe(true)
  expect(readFileSync(join(env.BUN_INSTALL_CACHE_DIR!,'kept'),'utf8')).toBe('cache')
})

it.each(['abcd1234','abcd1234/tmp','abcd1234/cache','.gitignore'])('rejects pre-existing runtime links at %s', async part => {
  const root=area(), outside=area()
  mkdirSync(join(root,'.cc-tasks',part,'..'),{recursive:true})
  symlinkSync(outside,join(root,'.cc-tasks',part),'dir')
  await expect(taskEnvironment(root,'abcd1234')).rejects.toThrow('invalid_task_environment')
  expect(existsSync(join(outside,'tmp'))).toBe(false)
})
