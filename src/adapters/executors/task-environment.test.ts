import { afterEach, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { commitWorktree } from '../git/worktree-workspaces'
import { takeCheckpoint } from '../../features/workbench/checkpoints'
import { captureGitBaseline, finishGitReview } from '../../features/workbench/git-review'
import { taskEnvironment } from './task-environment'
import { removeTempDir } from '../../lib/test-temp'
import { findOnPath } from '../../lib/util'

const dirs: string[] = []
const area = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'cc-task-env-'))); dirs.push(path); return path }
afterEach(() => dirs.splice(0).forEach(removeTempDir))

it('isolates task temp and Bun cache, reuses them on resume, and real child tools write inside the workspace', async () => {
  const root = area()
  execFileSync('git',['init','-q'],{cwd:root})
  const env = (await taskEnvironment(root, 'abcd1234'))
  expect(env).toEqual({ TMPDIR: join(root,'.cc-tasks/abcd1234/tmp'), TEMP: env.TMPDIR, TMP: env.TMPDIR, BUN_TMPDIR: env.TMPDIR, BUN_INSTALL_CACHE_DIR: join(root,'.cc-tasks/abcd1234/cache'), npm_config_cache: env.BUN_INSTALL_CACHE_DIR, GIT_CEILING_DIRECTORIES: env.TMPDIR, NODE_OPTIONS: env.NODE_OPTIONS, CC_TASK_SYSTEM_BOOT_MS: env.CC_TASK_SYSTEM_BOOT_MS, PATH: env.PATH })
  expect((await taskEnvironment(root,'abcd1234'))).toEqual(env)
  expect((await taskEnvironment(root,'abcd1235')).TMPDIR).not.toBe(env.TMPDIR)
  const path = execFileSync(process.execPath, ['-e', "process.stdout.write(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'test-')))"], { env: {...process.env,...env}, encoding: 'utf8' })
  expect(path.startsWith(env.TMPDIR!)).toBe(true)
  expect(existsSync(path)).toBe(true)
  expect(() => execFileSync('git',['rev-parse','--show-toplevel'],{cwd:path,env:{...process.env,...env},stdio:'pipe'})).toThrow()
})

it.skipIf(process.platform !== 'darwin').each(['node', 'bun'])('task preload recovers real sandbox uv_uptime EPERM for %s including named ESM imports', async runtime => {
  const root = area(), env = await taskEnvironment(root, 'abcd1234')
  const profile = '(version 1)(allow default)(deny sysctl-read (sysctl-name "kern.boottime"))'
  const code = "import {uptime} from 'node:os';import {spawnSync} from 'node:child_process';const n=uptime();if(!(n>60&&Number.isFinite(n)))throw Error('invalid fallback');const child=spawnSync(process.execPath,['-e',\"if(!(require('node:os').uptime()>60))process.exit(9)\"],{encoding:'utf8'});if(child.status!==0)throw Error('absolute child failed: '+child.status+child.stderr);console.log('fallback')"
  expect(() => execFileSync('/usr/bin/sandbox-exec', ['-p', profile, runtime, '--input-type=module', '-e', code], { env: process.env, stdio: 'pipe' })).toThrow()
  const output = execFileSync('/usr/bin/sandbox-exec', ['-p', profile, runtime, '--input-type=module', '-e', code], { env: { ...process.env, ...env }, encoding: 'utf8' })
  expect(output.trim()).toBe('fallback')
  // The parent process and all unrelated processes keep their own os module.
  expect(execFileSync(runtime, ['-e', "console.log(require('node:os').uptime()>0)"], { encoding: 'utf8' }).trim()).toBe('true')
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
  const env=await taskEnvironment(root,'abcd1234')
  const childEnv = { ...process.env }
  // npm config is case-insensitive, including on Windows. Never inherit a runner's
  // cache/config overrides; every npm invocation uses this task's private cache.
  for (const key of Object.keys(childEnv)) if (/^npm_config_/i.test(key)) delete childEnv[key]
  Object.assign(childEnv, env, { HOME: user, USERPROFILE: user })
  const config = ['--ignore-scripts','--offline','--no-audit','--no-fund','--update-notifier=false',
    '--userconfig='+join(user,'empty-npmrc'),'--globalconfig='+join(user,'global-npmrc')]
  writeFileSync(join(user,'empty-npmrc'),'')
  writeFileSync(join(user,'global-npmrc'),'')
  // npm's extensionless Windows launcher needs Bash; npm.cmd needs a shell.
  // Resolve the installed CLI and run it with Node, without either shell shim.
  const npmCmd = process.platform === 'win32'
    ? execFileSync('where.exe',['npm.cmd'],{encoding:'utf8',timeout:10_000,windowsHide:true}).trim().split(/\r?\n/)[0]!
    : undefined
  const npmArgs = npmCmd ? [join(dirname(npmCmd),'node_modules/npm/bin/npm-cli.js')] : []
  const npmNode = npmCmd && existsSync(join(dirname(npmCmd),'node.exe')) ? join(dirname(npmCmd),'node.exe') : 'node'
  const npm = async (args: string[]) => {
    try {
      // Allow cold tool startup/I/O under suite load; this is not a product deadline.
      return await run(npmCmd ? npmNode : 'npm',[...npmArgs,...args,...config],{cwd:root,env:childEnv,encoding:'utf8',timeout:30_000,windowsHide:true})
    } catch (error) {
      const failure = error as Error & { code?: string | number; signal?: string; killed?: boolean; stdout?: string; stderr?: string }
      throw new Error(`${failure.message}\ncode: ${failure.code}; signal: ${failure.signal}; killed: ${failure.killed}\nstdout:\n${failure.stdout ?? ''}\nstderr:\n${failure.stderr ?? ''}`, { cause: error })
    }
  }
  // Pack a local dependency and prime only this cache, entirely offline. Remove
  // the tarball before ci so success requires cached content, not a runner cache
  // or a file: directory link that could survive without reinstalling anything.
  const pkg=join(user,'package'), tarball=join(user,'offline-fixture-1.0.0.tgz')
  mkdirSync(pkg)
  writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'offline-fixture',version:'1.0.0',main:'index.js'}))
  writeFileSync(join(pkg,'index.js'),"module.exports = 'offline-cache-ok'\n")
  await npm(['pack',pkg,'--pack-destination='+user])
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'task-fixture',version:'1.0.0',dependencies:{'offline-fixture':'file:'+tarball.replaceAll('\\','/')}}))
  await npm(['install'])
  rmSync(tarball)
  rmSync(join(root,'node_modules/offline-fixture'),{recursive:true})
  writeFileSync(join(root,'node_modules/stale'),'ci must remove this')
  writeFileSync(join(env.BUN_INSTALL_CACHE_DIR!,'kept'),'cache')
  const result=await npm(['ci'])
  expect(result.stderr).not.toContain('ERR!')
  expect(existsSync(join(root,'node_modules/stale'))).toBe(false)
  expect(execFileSync(process.execPath,['-e',"process.stdout.write(require('offline-fixture'))"],{cwd:root,env:childEnv,encoding:'utf8'})).toBe('offline-cache-ok')
  const next=mkdtempSync(join(env.TMPDIR!,'after-ci-'))
  expect(existsSync(next)).toBe(true)
  expect(readFileSync(join(env.BUN_INSTALL_CACHE_DIR!,'kept'),'utf8')).toBe('cache')
}, 120_000)

it.each(['abcd1234','abcd1234/tmp','abcd1234/cache','.gitignore'])('rejects pre-existing runtime links at %s', async part => {
  const root=area(), outside=area()
  mkdirSync(join(root,'.cc-tasks',part,'..'),{recursive:true})
  symlinkSync(outside,join(root,'.cc-tasks',part),'dir')
  await expect(taskEnvironment(root,'abcd1234')).rejects.toThrow('invalid_task_environment')
  expect(existsSync(join(outside,'tmp'))).toBe(false)
})

it.skipIf(process.platform!=='darwin')('security: sandbox task cannot rewrite, replace or hardlink the trusted runtime',async()=>{
  const root=area(),env=await taskEnvironment(root,'abcd1234')
  const preload=JSON.parse(env.NODE_OPTIONS!.slice('--require '.length)) as string
  expect(preload.startsWith(root+'/')).toBe(false)
  const original=readFileSync(preload,'utf8')
  // Mirrors Codex workspace-write with /tmp excluded: only task root is writable.
  const profile=`(version 1)(deny default)(allow process*)(allow sysctl-read)(allow mach-lookup)(allow file-read*)(allow file-write* (subpath ${JSON.stringify(root)}))`
  const code=`const fs=require('node:fs');const p=${JSON.stringify(preload)};fs.writeFileSync(${JSON.stringify(join(root,'ordinary'))},'ok');for(const action of [()=>fs.writeFileSync(p,'poison'),()=>fs.renameSync(p,p+'.old'),()=>{fs.linkSync(p,${JSON.stringify(join(root,'link'))});fs.chmodSync(${JSON.stringify(join(root,'link'))},0o600);fs.writeFileSync(${JSON.stringify(join(root,'link'))},'poison')}]){try{action();process.exit(9)}catch{}}`
  execFileSync('/usr/bin/sandbox-exec',['-p',profile,'node','-e',code],{env:{...process.env,...env},stdio:'pipe'})
  expect(readFileSync(preload,'utf8')).toBe(original)
  writeFileSync(join(root,'.cc-tasks/abcd1234/uptime.cjs'),'throw Error("task poison")')
  expect(execFileSync('node',['-e',"console.log(require('node:os').uptime()>0)"],{env:{...process.env,...env},encoding:'utf8'}).trim()).toBe('true')
})


it.each(['node', 'bun'])('approved unsandboxed %s preserves native builtins when the task preload is loaded', async runtime => {
  const root = area(), task = await taskEnvironment(root, 'abcd1234')
  const preload = JSON.parse(task.NODE_OPTIONS!.slice('--require '.length)) as string
  const binary = realpathSync(findOnPath(runtime)!)
  const script = join(root, 'native-builtins.cjs')
  writeFileSync(script, `const assert = require('node:assert/strict');
const os = require('node:os'), cp = require('node:child_process');
const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync'];
const before = names.map(name => cp[name]), uptime = os.uptime;
const bun = globalThis.Bun, bunBefore = bun && [bun.spawn, bun.spawnSync];
require(${JSON.stringify(preload)});
assert.strictEqual(os.uptime, uptime, 'healthy host uptime must retain its native identity');
names.forEach((name, index) => assert.strictEqual(cp[name], before[index], name + ' must remain native'));
if (bun) { assert.strictEqual(bun.spawn, bunBefore[0]); assert.strictEqual(bun.spawnSync, bunBefore[1]); }
console.log('native-builtins-ok');
`)
  // Capture the real builtin identities before explicitly requiring the same
  // immutable preload. Automatic NODE_OPTIONS loading would precede capture.
  const output = execFileSync(binary, [script], {
    cwd: root, env: { ...process.env, ...task, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000,
  })
  expect(output.trim()).toBe('native-builtins-ok')
})

it.each(['node', 'bun'])('approved unsandboxed %s keeps clean child argv and native execFile results under the full task environment', async runtime => {
  const root = area(), task = await taskEnvironment(root, 'abcd1234')
  const script = join(root, 'host-child.cjs')
  writeFileSync(script, `const assert = require('node:assert/strict');
const cp = require('node:child_process'), {promisify} = require('node:util');
(async () => {
  const probe = 'process.stdout.write(JSON.stringify(process.execArgv))';
  const child = cp.spawnSync(process.execPath, ['-e', probe], {env: {}, encoding: 'utf8', timeout: 10_000});
  assert.strictEqual(child.status, 0, child.stderr);
  assert.ok(!JSON.parse(child.stdout).some(arg => arg.startsWith('--require')), 'preload must not be injected into clean child argv');
  const run = promisify(cp.execFile);
  const pending = run(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0, 255, 42]))'], {env: {}, encoding: 'buffer', timeout: 10_000});
  if (!globalThis.Bun) assert.ok(pending.child && pending.child.pid > 0, 'native promisified execFile must retain its child');
  const result = await pending;
  assert.ok(Buffer.isBuffer(result.stdout));
  assert.deepEqual([...result.stdout], [0, 255, 42]);
  console.log('native-children-ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
`)
  // Resolve through the actual task PATH wrappers, just as Codex's escalated
  // shell does. Node also receives its task NODE_OPTIONS unchanged.
  const output = execFileSync(runtime, [script], {
    cwd: root, env: { ...process.env, ...task }, encoding: 'utf8', timeout: 15_000,
  })
  expect(output.trim()).toBe('native-children-ok')
})
