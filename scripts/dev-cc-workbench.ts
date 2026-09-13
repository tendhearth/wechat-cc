import {createClaudeHistoryReader} from '../src/core/workbench/native-claude-history'
import {createCodexHistoryReader} from '../src/core/workbench/native-codex-history'
/** Live development: production task engine, isolated state, existing companion untouched.
 * bun scripts/dev-cc-workbench.ts
 * Only workbench writes are enabled in the frontend; no sample tasks are seeded.
 */
import {existsSync,mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs'
import {homedir} from 'node:os'
import {join,resolve} from 'node:path'
import {openDb} from '../src/lib/db'
import {findCodexBinary} from '../src/lib/find-codex-binary'
import {codexSessionJsonlPaths,claudeSessionJsonlPath} from '../src/daemon/bootstrap/session-paths'
import {createProviderRegistry} from '../src/core/provider-registry'
import {createWorkbenchCodexProvider} from '../src/core/workbench/codex-app-server'
import {createClaudeAgentProvider,makeWorkbenchClaudeCanUseTool} from '../src/core/claude-agent-provider'
import {workbenchClaudeOptions} from '../src/daemon/bootstrap/wire-workbench'
import {makeWorkbenchStore} from '../src/core/workbench/store'
import {makeWorkbenchService} from '../src/core/workbench/service'
import {createInternalApi,type InternalApiDeps} from '../src/daemon/internal-api'
import {workbenchClaudeAuthEnv} from './workbench-claude-config'

const root=resolve(import.meta.dir,'..')
const stateDir=join(homedir(),'.claude','channels','wechat-workbench-dev')
const infoPath=join(stateDir,'internal-api-info.json')
const binary=findCodexBinary()
const claudeCandidate=process.env.CLAUDE_CODE_EXECUTABLE || Bun.which('claude') || join(homedir(),'.local','bin','claude')
const claudeBinary=existsSync(claudeCandidate) ? claudeCandidate : null
if(!binary && !claudeBinary)throw new Error('尚未发现 Claude Code 或 Codex，请先安装并登录其中一个。')
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
if(binary)registry.register('codex',createWorkbenchCodexProvider({codexPathOverride:binary}),
  {displayName:'Codex',canResume:(_cwd,id)=>codexSessionJsonlPaths(homedir(),id).some(existsSync)})
if(claudeBinary)registry.register('claude',createClaudeAgentProvider({
  sdkOptionsForProject(_alias,path,_tier,_chatId,_env,instructions,context) {
    // Reuse login only; task sessions do not import CLI hooks or private MCPs.
    const settingsPath=join(homedir(),'.claude','settings.json')
    let settings:unknown={}
    if(existsSync(settingsPath)) {
      try { settings=JSON.parse(readFileSync(settingsPath,'utf8')) }
      catch { throw new Error('无法读取 Claude 登录设置，请检查设置文件格式。') }
    }
    return workbenchClaudeOptions({cwd:path,pathToClaudeCodeExecutable:claudeBinary,
      env:{...process.env,...workbenchClaudeAuthEnv(settings,process.env)}},
      instructions ?? '',makeWorkbenchClaudeCanUseTool(context?.requestPermission,context?.requestUserInput))
  },
}),{displayName:'Claude Code',canResume:(cwd,id)=>existsSync(claudeSessionJsonlPath(homedir(),cwd,id))})
// Unused companion dependencies are deliberately absent. Only the explicit
// workbench routes are reachable through the frontend proxy in this runner.
const api=createInternalApi({stateDir,daemonPid:process.pid} as InternalApiDeps)
const workbench=makeWorkbenchService({
    nativeHistory:{claude:createClaudeHistoryReader(),...(binary?{codex:createCodexHistoryReader({codexPathOverride:binary})}:{})},
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
console.log(`一起做：${[binary?'Codex':null,claudeBinary?'Claude Code':null].filter(Boolean).join(' / ')}，独立任务库 ${stateDir}\n页面：http://127.0.0.1:${port}/`)
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
