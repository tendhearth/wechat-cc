/**
 * CI 工作流的**接缝守卫**。
 *
 * ci.yml 里有三条约定,改错了不会当场红,只会让某个闸门安静地消失:
 *   ① `push.branches` 要含 `self/**` —— 自改流水线推的分支没有 CI,它的
 *      「CI 绿才进 dev」那道闸门就根本不存在,而日志里一切正常。
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
  it('push 分支含 self/**(自改流水线推的分支要有 CI 才有闸门)', () => {
    expect(on.push?.branches).toContain('self/**')
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

  it('e2e(vitest 那条重型作业)不受影响 —— 仍是 master/PR-only,没有 needs', () => {
    const e2e = jobs.e2e!
    expect(e2e.needs).toBeUndefined()
    expect(e2e.if).toBe("github.base_ref == 'master' || github.ref == 'refs/heads/master'")
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
    expect(changes.outputs?.app).toBe('${{ steps.filter.outputs.app }}')
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
