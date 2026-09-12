/** Live development: production task engine, isolated state, existing companion untouched.
 * bun scripts/dev-cc-workbench.ts
 * Only workbench writes are enabled in the frontend; no sample tasks are seeded.
 */
import {existsSync,mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs'
import {homedir} from 'node:os'
import {join,resolve} from 'node:path'
import {openDb} from '../src/lib/db'
import {findCodexBinary} from '../src/lib/find-codex-binary'
import {codexSessionJsonlPaths} from '../src/daemon/bootstrap/session-paths'
import {createProviderRegistry} from '../src/core/provider-registry'
import {createCodexAgentProvider} from '../src/core/codex-agent-provider'
import {makeWorkbenchStore} from '../src/core/workbench/store'
import {makeWorkbenchService} from '../src/core/workbench/service'
import {createInternalApi,type InternalApiDeps} from '../src/daemon/internal-api'
import {Codex} from '@openai/codex-sdk'
import {workbenchCodexConfig} from './workbench-codex-config'

const root=resolve(import.meta.dir,'..')
const stateDir=join(homedir(),'.claude','channels','wechat-workbench-dev')
const infoPath=join(stateDir,'internal-api-info.json')
const binary=findCodexBinary()
if(!binary)throw new Error('Codex 未安装，请先安装并登录 Codex。')
mkdirSync(stateDir,{recursive:true,mode:0o700})
if(existsSync(infoPath)) {
  const previous=JSON.parse(readFileSync(infoPath,'utf8'))
  if(Number.isInteger(previous.daemonPid)) {
    let alive=false
    try {process.kill(previous.daemonPid,0);alive=true} catch {}
    if(alive)throw new Error('独立任务服务已运行；请先停止该开发服务，避免同时写同一个任务库。')
  }
}
const db=openDb({path:join(stateDir,'workbench.db')})
const registry=createProviderRegistry()
registry.register('codex',{
  async spawn(project, context) {
    // Resolve the selected folder's configuration each turn, including project
    // overrides. Discovery only lists configuration; it never calls MCP tools.
    const probe=Bun.spawn([binary,'-c','features.plugins=false','-c','features.apps=false',
      '-c','features.hooks=false','mcp','list','--json'],{
      cwd:project.path,stdout:'pipe',stderr:'pipe',timeout:15_000,
    })
    const [stdout]=await Promise.all([new Response(probe.stdout).text(),new Response(probe.stderr).text()])
    if(await probe.exited!==0)throw new Error('无法核实 Codex 的工具配置；暂不启动任务。')
    const isolatedConfig=workbenchCodexConfig(JSON.parse(stdout))
    return createCodexAgentProvider({
      codexPathOverride:binary,dangerouslyBypassApprovalsAndSandbox:false,
      codexFactory:args=>new Codex({...args,config:{...args?.config,...isolatedConfig}}),
    }).spawn(project,context)
  },
},{displayName:'Codex',canResume:(_cwd,id)=>codexSessionJsonlPaths(homedir(),id).some(existsSync)})
// Unused companion dependencies are deliberately absent. Only the seven
// workbench routes are reachable through the frontend proxy in this runner.
const api=createInternalApi({stateDir,daemonPid:process.pid} as InternalApiDeps)
const workbench=makeWorkbenchService({
  store:makeWorkbenchStore(db),registry,stateDir,ownerChatId:()=>null,defaultProvider:'codex',
  mintSessionToken:key=>api.mintSessionToken('trusted',key,{routeAllow:new Set()}),
  revokeSessionToken:key=>api.invalidateSession(key),
})
api.setWorkbench(workbench)
const started=await api.start()
writeFileSync(infoPath,JSON.stringify({baseUrl:`http://127.0.0.1:${started.port}`,daemonPid:process.pid,...started}),{mode:0o600})
const port=process.env.WECHAT_CC_SHIM_PORT??'4187'
const shim=Bun.spawn(['bun','apps/desktop/test-shim.ts'],{
  cwd:root,stdout:'inherit',stderr:'inherit',env:{...process.env,
    WECHAT_CC_ROOT:root,WECHAT_CC_SHIM_PORT:port,WECHAT_CC_DRY_RUN:'0',
    WECHAT_CC_DEV_ALLOW_MUTATIONS:'0',WECHAT_CC_DEV_WORKBENCH_WRITES:'1',
    WECHAT_CC_WORKBENCH_STATE_DIR:stateDir,
  },
})
console.log(`一起做：真实 Codex 执行，独立任务库 ${stateDir}\n页面：http://127.0.0.1:${port}/`)
let stopping=false
async function stop() {
  if(stopping)return;stopping=true
  shim.kill()
  await workbench.shutdown()
  await api.stop()
  db.close()
  if(existsSync(infoPath))unlinkSync(infoPath)
}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void stop().then(()=>process.exit(0))})
const exitCode=await shim.exited
await stop()
process.exitCode=exitCode
