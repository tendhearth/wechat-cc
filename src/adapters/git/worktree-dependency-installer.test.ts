import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheWorkspaceDependencies, restoreWorkspaceDependencies } from './worktree-dependency-cache'
import { DEPENDENCY_NOTICE } from './worktree-dependencies'
import { removeTempDir } from '../../lib/test-temp'
import { preparationJobspawnFixture } from '../../test-support/preparation-jobspawn'
preparationJobspawnFixture()
const dirs:string[]=[]
afterEach(()=>dirs.splice(0).forEach(removeTempDir))
it.each([false,true])('real offline frozen staging install ignores task modules, scripts and config, then restores a completed cache (CRLF=%s)',async crlf=>{
  // Bun 1.3.14 computes escaping workspace paths when cwd still uses a Win32
  // 8.3 alias. Match the canonical paths used by product preparation/staging.
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'cc-clean-install-')));dirs.push(root)
  const source=join(root,'repo'),target=join(root,'target'),state=join(root,'state')
  mkdirSync(join(source,'pkg'),{recursive:true})
  const marker=join(root,'scripts-ran')
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'root',private:true,workspaces:['pkg'],dependencies:{'offline-workspace':'workspace:*'},main:'./index.js',scripts:{preinstall:`node -e "require('fs').writeFileSync('${marker.replaceAll('\\','/')}', 'bad')"`}}))
  writeFileSync(join(source,'pkg/package.json'),JSON.stringify({name:'offline-workspace',version:'1.0.0'}))
  execFileSync('bun',['install','--lockfile-only','--ignore-scripts','--no-cache'],{cwd:source,stdio:'pipe',timeout:15_000})
  if(crlf)writeFileSync(join(source,'bun.lock'),readFileSync(join(source,'bun.lock'),'utf8').replace(/\r?\n/g,'\r\n'))
  const git=(...args:string[])=>execFileSync('git',args,{cwd:source,stdio:'pipe'})
  git('init','-q');git('config','user.email','test@localhost');git('config','user.name','Fixture')
  if(crlf)git('config','core.autocrlf','true')
  writeFileSync(join(source,'.gitignore'),'node_modules/\n');git('add','.');git('commit','-qm','fixture');git('worktree','add','-qb','target',target)
  mkdirSync(join(source,'node_modules/task-poison'),{recursive:true});writeFileSync(join(source,'node_modules/task-poison/index.js'),'poison')
  // Even executable task config must not enter a supervisor installation.
  writeFileSync(join(source,'bunfig.toml'),'invalid task config')
  await cacheWorkspaceDependencies(source,state,{baseSha:git('rev-parse','HEAD').toString().trim()})
  expect(existsSync(marker)).toBe(false)
  const entries=readdirSync(join(state,'dependency-cache/v2')).filter(n=>!n.startsWith('.'))
  expect(entries).toHaveLength(1)
  const entry=join(state,'dependency-cache/v2',entries[0]!)
  expect(JSON.parse(readFileSync(join(entry,'.complete.json'),'utf8'))).toMatchObject({frozen:true,scripts:false,version:2})
  expect(readFileSync(join(entry,'bun.lock'))).toEqual(git('show','HEAD:bun.lock'))
  expect(existsSync(join(entry,'node_modules/task-poison'))).toBe(false)
  expect(existsSync(join(entry,'bunfig.toml'))).toBe(false)
  // Force the owner's direct copy to miss; only CC's cache can satisfy this.
  writeFileSync(join(source,'bun.lock'),'owner now differs')
  if(crlf)expect(readFileSync(join(target,'bun.lock'),'utf8')).toContain('\r\n')
  expect(await restoreWorkspaceDependencies(source,target,state,{baseSha:git('rev-parse','HEAD').toString().trim()})).not.toContain(DEPENDENCY_NOTICE)
  expect(realpathSync.native(join(target,'node_modules/offline-workspace'))).toBe(realpathSync.native(join(target,'pkg')))
  expect(existsSync(join(target,'node_modules/task-poison'))).toBe(false)
},30_000)
