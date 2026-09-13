/** Owned OS-process deadline proof; no model endpoint, credentials or user MCP.
 * Run: bun scripts/workbench-model-catalog-deadline-smoke.ts --run */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {chmod,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {discoverCodexModels} from '../src/core/workbench/codex-model-catalog'
import {discoverClaudeModels} from '../src/core/workbench/claude-model-catalog'
import {findCodexBinary} from '../src/lib/find-codex-binary'

if(!process.argv.includes('--run')){console.log('Use --run for owned native catalog timeout fixtures.');process.exit(0)}
assert.equal(process.platform,'darwin')
const codex=findCodexBinary(),claude=Bun.which('claude');assert(codex&&claude)
const area=await realpath(await mkdtemp(join(tmpdir(),'cc-catalog-deadline-'))),safePath=process.env.PATH??'/usr/bin:/bin'
for(const key of Object.keys(process.env))delete process.env[key]
Object.assign(process.env,{PATH:safePath,HOME:area,CODEX_HOME:area,TMPDIR:area,LANG:'en_US.UTF-8',TERM:'dumb'})
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`
const sandbox='(version 1) (allow default) (deny network*)'
const results:unknown[]=[]
await mkdir(join(area,'.claude'))
await writeFile(join(area,'config.toml'),"model='owned'\nmodel_provider='owned'\n[model_providers.owned]\nname='Owned timeout fixture'\nbase_url='http://127.0.0.1:1/v1'\nwire_api='responses'\nrequires_openai_auth=false\n[features]\nplugins=false\napps=false\nhooks=false\n")
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error}}
async function gone(file:string){
  const pid=Number(await readFile(file,'utf8'));assert(Number.isInteger(pid)&&pid>1)
  const deadline=Date.now()+300
  while(alive(pid)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10))
  assert(!alive(pid),`Owned process still alive: ${pid}`)
}
try {
  for(const phase of ['config','app-server'] as const) {
    const wrapper=join(area,`codex-${phase}`),pid=join(area,`${phase}.pid`),descendant=join(area,`${phase}-child.pid`),started=join(area,`${phase}-app-started`)
    const configBody=phase==='config'?`printf '%s' "$$" > ${quote(pid)}\nsleep 2 &\nprintf '%s' "$!" > ${quote(descendant)}\nwait\nprintf '[]'\nexit 0`:`exec /usr/bin/sandbox-exec -p ${quote(sandbox)} ${quote(codex)} "$@"`
    await writeFile(wrapper,`#!/bin/sh\ncase " $* " in\n*" mcp "*)\n${configBody}\n;;\nesac\nprintf started > ${quote(started)}\nprintf '%s' "$$" > ${quote(pid)}\nsleep 2 &\nprintf '%s' "$!" > ${quote(descendant)}\nexec /usr/bin/sandbox-exec -p ${quote(sandbox)} ${quote(codex)} "$@" > /dev/null\n`)
    await chmod(wrapper,0o700)
    execFileSync('/bin/sh',['-n',wrapper])
    const before=Date.now(),budget=1000
    await assert.rejects(discoverCodexModels(wrapper,area,budget),/model_catalog_unavailable/)
    const elapsedMs=Date.now()-before;assert(elapsedMs>=budget-50&&elapsedMs<budget+200,`${phase} did not use its single timeout budget`)
    await gone(pid);await gone(descendant)
    if(phase==='config')await assert.rejects(readFile(started),'Expired config discovery started a new app-server')
    else assert.equal(await readFile(started,'utf8'),'started')
    results.push({provider:'codex',phase,budgetMs:budget,elapsedMs,ownedProcessAndDescendantExited:true,noLateSecondSpawn:phase==='config'})
  }
  const wrapper=join(area,'claude-stalled'),pid=join(area,'claude.pid')
  await writeFile(wrapper,`#!/bin/sh\nprintf '%s' "$$" > ${quote(pid)}\nexec /usr/bin/sandbox-exec -p ${quote(sandbox)} ${quote(claude)} "$@" > /dev/null\n`);await chmod(wrapper,0o700)
  const before=Date.now(),budget=1000
  await assert.rejects(discoverClaudeModels({cwd:area,pathToClaudeCodeExecutable:wrapper,env:{HOME:area,CLAUDE_CONFIG_DIR:join(area,'.claude'),ANTHROPIC_API_KEY:'owned-timeout-key',ANTHROPIC_BASE_URL:'http://127.0.0.1:1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DISABLE_AUTOUPDATER:'1'}},budget),/model_catalog_unavailable/)
  const elapsedMs=Date.now()-before;assert(elapsedMs>=budget-50&&elapsedMs<budget+200)
  await gone(pid)
  results.push({provider:'claude',phase:'initialization',budgetMs:budget,elapsedMs,nativeProcessExited:true})
  console.log(JSON.stringify({allNetworkDenied:true,results},null,2))
}finally{await rm(area,{recursive:true,force:true})}
