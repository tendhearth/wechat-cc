import { describe, expect, it } from 'vitest'

import { defaultPipelineDeps, makeSelftest, selfDeployPlanFor } from './index'
import { fakeState, makeFakeDeps, okDeploy, okSelftest, testConfig } from './pipeline.fixture'

// 这个文件只钉住 defaultPipelineDeps 里**两处真件容易接错、接错了又只有真机
// 才看得出来**的地方。其余注入口(git / runner / daemon / exec)在各自的
// *.test.ts 里已经钉过了,这里不重复。

function plistWith(programArgs: string[]): string {
  const argsXml = programArgs.map(a => `    <string>${a}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.wechat-cc.daemon</string>
  <key>ProgramArguments</key><array>
${argsXml}
  </array>
  <key>StandardErrorPath</key><string>/Users/nate/.claude/channels/wechat/launchd.err.log</string>
</dict></plist>
`
}

const PLIST = plistWith(['/Applications/wechat-cc.app/Contents/MacOS/wechat_cc_desktop', '--daemon', 'run'])

// platform / arch / uid 都是参数(不是直接读 process),所以这组断言在 Linux
// 和 Windows 的 CI 作业上也照跑 —— planSelfDeploy 在非 darwin 上直接抛。
const BASE = {
  platform: 'darwin' as const,
  arch: 'arm64',
  homeDir: '/Users/nate',
  uid: 501,
  repoRoot: '/Users/nate/Library/Caches/wechat-cc/self-change/repo',
  stateDir: '/Users/nate/.claude/channels/wechat',
  plistXml: PLIST,
}

describe('selfDeployPlanFor', () => {
  it('部署用的是克隆里新构出来的 sidecar', () => {
    const plan = selfDeployPlanFor({ ...BASE, mode: 'deploy' })
    expect(plan.newBinaryPath.startsWith(BASE.repoRoot)).toBe(true)
    expect(plan.newBinaryPath).not.toBe(plan.prevPath)
    expect(plan.rollback).toBe(true)
  })

  // 回滚接错(比如又去拿克隆里那份刚构出来的新二进制)= 自检红了之后换上去的
  // 还是同一个坏版本,机器再也起不来。
  it('回滚把新二进制指到上一版的 .prev,并且自己不再回滚', () => {
    const forward = selfDeployPlanFor({ ...BASE, mode: 'deploy' })
    const back = selfDeployPlanFor({ ...BASE, mode: 'rollback' })

    expect(back.newBinaryPath).toBe(forward.prevPath)
    expect(back.newBinaryPath.endsWith('.prev')).toBe(true)
    // 同一个部署目标,只是来源换了。
    expect(back.sidecarPath).toBe(forward.sidecarPath)
    expect(back.serviceTarget).toBe(forward.serviceTarget)
    // 回滚失败不该再触发一次回滚(否则两个坏二进制之间来回换)。
    expect(back.rollback).toBe(false)
  })

  // 2026-09-28:Developer ID 到手后 self deploy 会重签;流水线的部署与回滚都得带上
  // 同一份签名输入,否则自改部署出来的 sidecar 又变回 ad-hoc、TCC 授权又掉。
  it('签名输入原样进 plan —— 部署与回滚都带;不给 ⇒ null', () => {
    const signed = { signingIdentity: { name: 'Developer ID Application: X (T)', hash: 'A'.repeat(40) }, entitlementsPath: `${BASE.repoRoot}/apps/desktop/src-tauri/entitlements.plist` }
    const forward = selfDeployPlanFor({ ...BASE, mode: 'deploy', ...signed })
    const back = selfDeployPlanFor({ ...BASE, mode: 'rollback', ...signed })
    expect(forward.signing).toEqual({ identity: 'Developer ID Application: X (T)', identityHash: 'A'.repeat(40), entitlementsPath: signed.entitlementsPath, appPath: '/Applications/wechat-cc.app' })
    expect(back.signing).toEqual(forward.signing)
    expect(selfDeployPlanFor({ ...BASE, mode: 'deploy' }).signing).toBeNull()
  })
})

describe('makeSelftest', () => {
  it('用配置里的 executor / provider,而不是写死的 claude', async () => {
    const seen: Array<Record<string, unknown>> = []
    const selftest = makeSelftest(testConfig({ selftestExecutor: 'cursor', selftestProvider: 'kimi' }), {
      workbench: async (o) => { seen.push({ kind: 'workbench', ...o }); return okSelftest('workbench') },
      chat: async (o) => { seen.push({ kind: 'chat', ...o }); return okSelftest('chat') },
    })

    const r = await selftest()

    expect(seen).toEqual([
      { kind: 'workbench', executor: 'cursor', image: true, resume: true },
      { kind: 'chat', provider: 'kimi', resume: true },
    ])
    expect(r.workbench.ok).toBe(true)
    expect(r.chat.ok).toBe(true)
  })

  it('工作台红了也照样把对话那条跑完(报告要说清是一条红还是两条都红)', async () => {
    let chatRan = false
    const selftest = makeSelftest(testConfig(), {
      workbench: async () => okSelftest('workbench', false),
      chat: async () => { chatRan = true; return okSelftest('chat') },
    })

    const r = await selftest()

    expect(chatRan).toBe(true)
    expect(r.workbench.ok).toBe(false)
    expect(r.chat.ok).toBe(true)
  })
})


describe('noninteractive self-change deployment task gate wiring',()=>{
  it.each(['busy','unknown','query-error'] as const)('%s blocks without using deployment failure budget',async kind=>{
    const {runSelfChange}=await import('./run')
    let now=0,calls=0,replacements=0
    const {deps,rec}=makeFakeDeps({config:{failStreak:1},exists:()=>true,git:(args)=>({code:0,stdout:args.join(' ')==='rev-parse HEAD'?'abc123':'',stderr:''})})
    const production=defaultPipelineDeps('/offline-state',deps.config,{
      repoRoot:'/offline-repo',runId:'aa11bb22',
      deployFromRepo:async()=>{replacements++;return okDeploy(false)},
      deployTasks:{interactive:true,choose:async()=>{throw Error('must not prompt')},
        tasks:async()=>{calls++;if(kind==='query-error')throw Error('offline');return kind==='unknown'?null:[{id:'busy',title:'正在做',status:'running',phase:'working'}]},
        now:()=>now,sleep:async(ms:number)=>{now+=ms},log:()=>{}},
    })
    deps.deploy=production.deploy
    const s=fakeState({id:'aa11bb22',step:'deploy',merge:{sha:'abc123',rebased:false}})
    const result=await runSelfChange(s,deps)
    expect(result.state.result).toBe('deploy_tasks_blocked')
    expect(result.exitCode).toBe(2)
    expect(result.state.step).toBe('deploy')
    expect(replacements).toBe(0)
    expect(deps.config.failStreak).toBe(1)
    expect(rec.patches).toEqual([])
    expect(rec.notices.join('\n')).toContain('未部署')
    if(kind==='busy') {
      expect(now).toBe(20*60_000)
      expect(calls).toBeGreaterThan(1)
      expect(result.state.error).toContain('超时')
    } else {expect(now).toBe(0);expect(result.state.error).toContain('读不到')}
  })
})

it('self-change preserves bounded task policy at the second deployment gate',async()=>{
  const {runSelfChange}=await import('./run')
  const {deps,rec}=makeFakeDeps({config:{failStreak:1},exists:()=>true,git:args=>({stdout:args.join(' ')==='rev-parse HEAD'?'approved':''})})
  let options:unknown
  deps.deploy=defaultPipelineDeps('/offline-state',deps.config,{
    repoRoot:'/offline-repo',runId:'aa11bb22',
    deployTasks:{tasks:async()=>[],interactive:false,now:()=>0,sleep:async()=>{},log:()=>{}},
    deployFromRepo:async(_state,_repo,_mode,opts)=>{options=opts;return {ok:false,exitCode:1,blocked:'tasks',steps:[{name:'tasks',ok:false,detail:'读不到交办任务状态，未部署。'}]}},
  }).deploy
  const result=await runSelfChange(fakeState({id:'aa11bb22',step:'deploy',merge:{sha:'approved',rebased:false}}),deps)
  expect(options).toEqual({waitTasks:true,timeoutMs:20*60_000,nonInteractive:true})
  expect(result.state.result).toBe('deploy_tasks_blocked')
  expect(result.exitCode).toBe(2)
  expect(deps.config.failStreak).toBe(1)
  expect(rec.patches).toEqual([])
})
