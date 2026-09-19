import { describe, expect, it } from 'vitest'

import { makeSelftest, selfDeployPlanFor } from './index'
import { okSelftest, testConfig } from './pipeline.fixture'

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
