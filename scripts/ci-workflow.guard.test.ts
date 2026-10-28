/**
 * CI 工作流的**接缝守卫**。
 *
 * ci.yml 里有三条约定,改错了不会当场红,只会让某个闸门安静地消失:
 *   ① 自改流水线的 CI 认 PR(2026-10-23 起它推 self/<id> 时开进 dev 的 PR):`pull_request`
 *      不能限 base、`push.branches` 不能再含 `self/**`(同一提交跑两遍,ci land 等两份 rollup),
 *      自改的 PR 照旧三平台。哪一条漏了,「CI 绿才进 dev」那道闸门要么安静地没了、要么安静地变窄。
 *   ② `changes` 作业算出 `apps/desktop/**` 动没动过,`desktop-e2e` 靠它的
 *      输出决定在 dev 推送上跑不跑。少了 `needs` 或 `if` 里少了那半句,
 *      桌面改动又退回「合并前才知道红」。
 *   ③ 三处 `setup-bun` 都钉 1.3.14。2026-09-15 上游发到 1.4.2,CI 在没有
 *      任何提交的情况下自己变红 —— 这条规矩原先只活在注释里。
 *
 * 跟 release-pipeline.guard.test.ts 一样:不测逻辑,测「约定还对得上」。
 * 注:只在 bun 下跑(vitest.node.config.ts 只收 src/**)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// import.meta.dir 是 Bun 的扩展,vitest 转译后是 undefined —— 用标准写法。
const HERE = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(HERE, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
const doc = parse(raw) as Record<string, unknown>

// YAML 1.1 把裸 `on` 读成布尔 true;yaml@2 默认 1.2 core schema 读成字符串 'on'。
// 两种都认,免得哪天换解析器这份守卫自己失灵。
const on = (doc.on ?? (doc as Record<string | number, unknown>)[true as unknown as string]) as {
  push?: { branches?: string[] }
  pull_request?: { branches?: string[] }
}
const jobs = doc.jobs as Record<string, {
  needs?: string | string[]
  if?: string
  outputs?: Record<string, string>
  steps?: Array<{ uses?: string; id?: string; with?: Record<string, unknown> }>
}>

describe('ci.yml —— 触发面', () => {
  it('自改走 PR 拿 CI:pull_request 不限 base,push 不再列 self/**(不然同一提交跑两遍)', () => {
    expect(on.pull_request?.branches).toBeUndefined()
    expect(on.push?.branches).not.toContain('self/**')
  })

  it('master / dev 仍在 push 分支里', () => {
    expect(on.push?.branches).toEqual(expect.arrayContaining(['master', 'dev']))
  })
})

describe('ci.yml —— desktop-e2e 按路径在 dev 上跑', () => {
  it('changes 作业存在,过滤器盯的是 apps/desktop/**', () => {
    const changes = jobs.changes
    expect(changes, 'jobs.changes 不见了').toBeTruthy()
    const filterStep = changes!.steps?.find(s => typeof s.uses === 'string' && s.uses.startsWith('dorny/paths-filter@'))
    expect(filterStep, 'changes 作业里没有 dorny/paths-filter 步骤').toBeTruthy()
    expect(String(filterStep!.with?.filters)).toContain('apps/desktop/**')
  })

  it('changes 作业把结果导出成 desktop 输出', () => {
    expect(jobs.changes?.outputs?.desktop).toBeTruthy()
  })

  it('desktop-e2e needs changes,且 if 里认这个输出', () => {
    const e2e = jobs['desktop-e2e']!
    const needs = Array.isArray(e2e.needs) ? e2e.needs : [e2e.needs]
    expect(needs).toContain('changes')
    expect(e2e.if).toContain("needs.changes.outputs.desktop == 'true'")
    // master / PR 上照旧无条件跑。
    expect(e2e.if).toContain("github.base_ref == 'master'")
    expect(e2e.if).toContain("github.ref == 'refs/heads/master'")
  })

  it('e2e(vitest 那条重型作业):所有 PR 都跑(含叠在别的分支上的)、master 推送也跑,直接推 dev 跳过;只改 Markdown 时跳过', () => {
    // 2026-10-04:#197 把两条 e2e 弄红,只在 base=master 时跑 ⇒ 红了两天没人知道。
    const e2e = jobs.e2e!
    expect(e2e.needs).toBe('changes')
    expect(e2e.if).toBe("needs.changes.outputs.code == 'true' && (github.event_name == 'pull_request' || github.ref == 'refs/heads/master')")
  })
})

describe('ci.yml —— e2e 作业要装 Playwright chromium', () => {
  // 2026-09-27 PR #121(dev→master)第一次跑 e2e 就红:src/daemon/__e2e__/mobile-workbench.e2e.test.ts
  // (09-22 加的)用 Playwright 驱动真页面,而 e2e 作业只 bun install、没装浏览器 ——
  // 「Executable doesn't exist at ~/.cache/ms-playwright/…」。desktop-e2e 作业早就有这一步。
  it('e2e 作业里有一步 `playwright install … chromium`(__e2e__ 里有测试 import playwright)', () => {
    const steps = jobs.e2e!.steps ?? []
    const install = steps.find(s => typeof (s as { run?: unknown }).run === 'string' && /playwright install .*chromium/.test(String((s as { run?: string }).run)))
    expect(install, 'e2e 作业缺 playwright install chromium 步骤').toBeTruthy()
  })
})

describe('三个 workflow —— bun 版本钉死', () => {
  it('ci.yml / desktop.yml / publish-update.yml / relay.yml 每一处 setup-bun 都是 1.3.14(2026-09-15 bun 1.4.2 把 CI 弄红;发版链此前仍是 latest,2026-09-27 一并钉住)', () => {
    const pins: string[] = []
    for (const file of ['ci.yml', 'desktop.yml', 'publish-update.yml', 'relay.yml']) {
      const wf = parse(readFileSync(join(HERE, '..', '.github', 'workflows', file), 'utf8')) as { jobs: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }> }
      for (const job of Object.values(wf.jobs)) {
        for (const step of job.steps ?? []) {
          if (typeof step.uses === 'string' && step.uses.startsWith('oven-sh/setup-bun@')) {
            pins.push(`${file}:${String(step.with?.['bun-version'])}`)
          }
        }
      }
    }
    expect(pins.length).toBeGreaterThanOrEqual(6)
    for (const p of pins) expect(p, p).toMatch(/:1\.3\.14$/)
  })
})

describe('ci.yml —— 中继作业', () => {
  it('changes 算出 relay 输出,relay 作业依赖它', () => {
    const changes = jobs.changes!
    expect(changes.outputs?.relay).toBeDefined()
    const filter = changes.steps?.find(s => s.id === 'filter')?.with?.filters as string
    expect(filter).toContain('apps/relay/**')
    expect(filter).toContain('packages/protocol/**')
    const relay = jobs.relay!
    expect(relay.needs).toContain('changes')
    expect(relay.if).toContain("needs.changes.outputs.relay == 'true'")
  })
  it('relay 作业的 setup-bun 也钉 1.3.14', () => {
    const bun = jobs.relay!.steps?.find(s => s.uses?.startsWith('oven-sh/setup-bun'))
    expect(bun?.with?.['bun-version']).toBe('1.3.14')
  })
})

describe('ci.yml —— Tendhearth 手机 app 作业', () => {
  it('changes 算出 app 输出(apps/app 与协议包),app 作业依赖它', () => {
    const changes = jobs.changes!
    expect(changes.outputs?.app).toBe('${{ steps.stack.outputs.all || steps.filter.outputs.app }}')
    const filter = parse(changes.steps?.find(s => s.id === 'filter')?.with?.filters as string) as Record<string, string[]>
    expect(filter.app).toEqual(expect.arrayContaining(['apps/app/**', 'packages/protocol/**']))
    const app = jobs.app!
    expect(app.needs).toContain('changes')
    expect(app.if).toContain("needs.changes.outputs.app == 'true'")
  })
  it('app 作业的 setup-bun 也钉 1.3.14', () => {
    const bun = jobs.app!.steps?.find(s => s.uses?.startsWith('oven-sh/setup-bun'))
    expect(bun?.with?.['bun-version']).toBe('1.3.14')
  })
  it('app-native 作业只在 apps/app/native/** 或协议包动过时跑,且跑 Swift 与 Kotlin 两端', () => {
    const changes = jobs.changes!
    expect(changes.outputs?.app_native).toBe('${{ steps.stack.outputs.all || steps.filter.outputs.app_native }}')
    const filter = parse(changes.steps?.find(s => s.id === 'filter')?.with?.filters as string) as Record<string, string[]>
    expect(filter.app_native).toEqual(['apps/app/native/**', 'packages/protocol/**'])
    const native = jobs['app-native']!
    expect(native.needs).toContain('changes')
    expect(native.if).toContain("needs.changes.outputs.app_native == 'true'")
    const text = JSON.stringify(native)
    expect(text).toContain('swift test')
    expect(text).toContain('android-push/test.sh')
  })
})

// 2026-10-27:测试只增不减 + 修 bug 要有红/绿。这道闸门安静地没了(作业改成也在 push 上跑 ⇒ 读不到描述、
// 浅克隆 ⇒ 找不到 merge-base、标题插进 run ⇒ 能被注入)都不会当场红,钉在这里。
describe('ci.yml —— pr-rules(测试只增不减 + 红/绿)', () => {
  const job = jobs['pr-rules'] as { needs?: string; if?: string; steps?: Array<{ uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string }> } | undefined
  it('只在 PR 上跑、认 code 输出(只改 Markdown 跳过)', () => {
    expect(job, 'jobs.pr-rules 不见了').toBeTruthy()
    expect(job!.needs).toBe('changes')
    expect(job!.if).toBe("needs.changes.outputs.code == 'true' && github.event_name == 'pull_request'")
  })
  it('全量历史(要算 merge-base),跑的是 scripts/test-shrink-check.ts', () => {
    expect(job!.steps?.find(s => s.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth']).toBe(0)
    const step = job!.steps?.find(s => s.run?.includes('scripts/test-shrink-check.ts'))
    expect(step, '没有跑 test-shrink-check 的那一步').toBeTruthy()
  })
  it('PR 标题和描述经 env 传,run 里不插值', () => {
    const step = job!.steps!.find(s => s.run?.includes('scripts/test-shrink-check.ts'))!
    expect(step.env).toEqual({ PR_TITLE: '${{ github.event.pull_request.title }}', PR_BODY: '${{ github.event.pull_request.body }}' })
    expect(step.run).not.toContain('${{')
  })
})

describe('中继工作流 —— 未配置 Cloudflare 时整体跳过', () => {
  const load = (f: string) => parse(readFileSync(join(HERE, '..', '.github', 'workflows', f), 'utf8')) as { jobs: Record<string, { if?: string }>; on?: { schedule?: Array<{ cron: string }> } }
  it('relay.yml 的部署作业受 RELAY_DEPLOY 开关控制', () => {
    expect(load('relay.yml').jobs.deploy!.if).toContain("vars.RELAY_DEPLOY == 'on'")
  })
  it('relay-watch.yml 受 RELAY_WATCH 开关控制,且每小时一次', () => {
    const wf = load('relay-watch.yml')
    expect(wf.jobs.watch!.if).toContain("vars.RELAY_WATCH == 'on'")
    const on = (wf.on ?? (wf as Record<string, unknown>)[true as unknown as string]) as { schedule: Array<{ cron: string }> }
    expect(on.schedule[0]!.cron).toBe('0 * * * *')
  })
})

// 2026-10-23:一次 CI 约 20 分钟,开发一直在等。三处提速,各自的边界钉在这里 —— 放宽一步就是安静地少一道闸。
describe('ci.yml —— 提速的边界', () => {
  const codeStep = jobs.changes!.steps?.find(s => s.id === 'code')
  it('code 过滤器只排除 Markdown(别的文件都算代码),且单独一步用 every', () => {
    expect(codeStep?.uses).toMatch(/^dorny\/paths-filter@/)
    expect(codeStep?.with?.['predicate-quantifier']).toBe('every')
    const f = parse(codeStep?.with?.filters as string) as Record<string, string[]>
    expect(f.code).toEqual(['**', '!**/*.md'])
    expect(jobs.changes!.outputs?.code).toBe('${{ steps.stack.outputs.all || steps.code.outputs.code }}')
    // 放进 id=filter 那一步,relay / app 这种多路径过滤器就变成「同时匹配」。
    expect(jobs.changes!.steps?.find(s => s.id === 'filter')?.with?.['predicate-quantifier']).toBeUndefined()
  })
  it('build / node / e2e / desktop-e2e 都认 code 输出', () => {
    for (const name of ['build', 'node', 'e2e', 'desktop-e2e']) {
      const j = jobs[name]!
      const needs = Array.isArray(j.needs) ? j.needs : [j.needs]
      expect(needs, name).toContain('changes')
      expect(j.if, name).toContain("needs.changes.outputs.code == 'true'")
    }
  })
  it('不进 master 的 PR 跳过 Windows;推 dev、进 master 的 PR、自改的 PR 照旧三平台', () => {
    const os = String((jobs.build as { strategy?: { matrix?: { os?: unknown } } }).strategy?.matrix?.os)
    expect(os).toContain("github.event_name == 'pull_request' && github.base_ref != 'master' && !startsWith(github.head_ref, 'self/')")
    expect(os).toContain('["ubuntu-latest","macos-latest"]')
    expect(os).toContain('["ubuntu-latest","macos-latest","windows-latest"]')
  })
  it('真实形状沙盒三个平台一样挡:不许 continue-on-error(Windows 在 dev 上连续绿过,2026-10-26 去掉的)', () => {
    const step = (jobs.build!.steps ?? []).find(s => (s as { name?: string }).name === 'Real-shaped sandbox') as Record<string, unknown> | undefined
    expect(step?.run).toBe('bun run test:sandbox')
    expect(step).not.toHaveProperty('continue-on-error')
  })
  it('只取消同一个 PR 的旧运行,推送一条都不取消', () => {
    const c = doc.concurrency as { group: string; 'cancel-in-progress': string }
    expect(c['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}")
    // 推送按 sha 分组:两次推 dev 不会互相顶掉(ci triage --wait 等的是具体提交)。
    expect(c.group).toContain('github.sha')
    expect(c.group).toContain('github.event.pull_request.number')
  })
  it('pull_request 不限 base:叠起来的上层 PR(base 是 claude/…)也要有 CI,一串的闸门就是它', () => {
    expect(on.pull_request?.branches).toBeUndefined()
  })
  it('叠起来的 PR 每个 changes 输出都强制 true(paths-filter 只看得见这一层,看不见下层)', () => {
    const stack = jobs.changes!.steps?.find(s => s.id === 'stack') as { if?: string; run?: string } | undefined
    expect(stack?.if).toBe("github.event_name == 'pull_request' && github.base_ref != 'dev' && github.base_ref != 'master'")
    expect(stack?.run).toContain('all=true')
    for (const [k, v] of Object.entries(jobs.changes!.outputs ?? {})) expect(v, k).toMatch(/^\$\{\{ steps\.stack\.outputs\.all \|\| /)
  })
})
