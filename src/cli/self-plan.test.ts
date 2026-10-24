import { describe, expect, it } from 'vitest'

import type { GitResult } from './self-change/git'
import type { RunnerInput, RunnerResult } from './self-change/runner'
import { formatPlan, markStepDone, nextSteps, parsePlan, planPrompt, runPlan, stepGate, topoOrder, type PlanDeps, type SavedPlan } from './self-plan'

const block = (o: unknown) => `想了想。\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``
const PLAN = {
  summary: '手机上能看到 CC 自己在改什么',
  designFirst: true,
  prs: [
    { id: 'p1', title: '设计稿', why: '先定', scope: ['docs/'], dependsOn: [], visible: false, verify: '无' },
    { id: 'p3', title: '手机页', why: '主人看', scope: ['apps/app/'], dependsOn: ['p2'], visible: true, verify: 'Maestro' },
    { id: 'p2', title: '接口', why: '给页用', scope: ['src/daemon/'], dependsOn: ['p1'], visible: false, verify: '单测' },
  ],
  questions: ['放在此刻还是一起做?推荐一起做'],
}

describe('parsePlan', () => {
  it('取最后一个 json 块,按依赖排序,保留 visible / designFirst / questions', () => {
    const r = parsePlan(block({ prs: [] }) + '\n' + block(PLAN), '目标')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.order).toEqual(['p1', 'p2', 'p3'])
    expect(r.plan.designFirst).toBe(true)
    expect(r.plan.prs.find(p => p.id === 'p3')?.visible).toBe(true)
    expect(r.plan.questions).toHaveLength(1)
  })

  it('整段就是一个对象也认(Codex 常这样回)', () => {
    expect(parsePlan(JSON.stringify(PLAN), 'g').ok).toBe(true)
  })

  it('不成形的一律拒,并说为什么:没有 json、没有 PR、编号重复、依赖不存在、依赖自己、成环、没标题', () => {
    const bad = (o: unknown) => { const r = parsePlan(typeof o === 'string' ? o : block(o), 'g'); return r.ok ? 'ok' : r.error }
    expect(bad('我觉得可以这样做')).toMatch(/没有给出/)
    expect(bad({ prs: [] })).toMatch(/一个 PR 都没有/)
    expect(bad({ prs: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }] })).toMatch(/重复/)
    expect(bad({ prs: [{ id: 'a', title: 'x', dependsOn: ['zz'] }] })).toMatch(/不存在的 zz/)
    expect(bad({ prs: [{ id: 'a', title: 'x', dependsOn: ['a'] }] })).toMatch(/依赖了自己/)
    expect(bad({ prs: [{ id: 'a', title: 'x', dependsOn: ['b'] }, { id: 'b', title: 'y', dependsOn: ['a'] }] })).toMatch(/成环/)
    expect(bad({ prs: [{ id: 'a' }] })).toMatch(/没有标题/)
  })

  it('visible 只认 true(别的都当 false,宁可少问不乱标)', () => {
    const r = parsePlan(block({ prs: [{ id: 'a', title: 'x', visible: 'yes' }] }), 'g')
    expect(r.ok && r.plan.prs[0]!.visible).toBe(false)
  })
})

describe('topoOrder', () => {
  it('同层按出现先后;能并行的不串', () => {
    expect(topoOrder([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: [] }, { id: 'c', dependsOn: ['a', 'b'] }])).toEqual(['a', 'b', 'c'])
  })
})

describe('planPrompt / formatPlan', () => {
  it('提示词让它读做法清单、标主人看得见的、最后只回 json;候选有就带上', () => {
    const p = planPrompt({ goal: '手机看自改进度', branch: 'dev', candidates: '84 次 [INGEST] …' })
    expect(p).toContain('docs/maintainer/practices.md')
    expect(p).toContain('visible: true')
    expect(p).toContain('```json')
    expect(p).toContain('84 次 [INGEST]')
    expect(planPrompt({ goal: 'x', branch: 'dev' })).not.toContain('self discover')
  })

  it('人读版:按顺序、标出要点头的、列出问题', () => {
    const r = parsePlan(block(PLAN), '手机看自改进度')
    if (!r.ok) throw new Error(r.error)
    const t = formatPlan(r.plan, r.order)
    expect(t.indexOf('p1')).toBeLessThan(t.indexOf('p2'))
    expect(t.indexOf('p2')).toBeLessThan(t.indexOf('p3'))
    expect(t).toContain('[主人看得见 ⇒ 先停在设计稿等点头]')
    expect(t).toContain('要主人点头的:p3')
    expect(t).toContain('放在此刻还是一起做')
    expect(t).toContain('先写设计稿')
  })
})

describe('runPlan', () => {
  function harness(o: { text?: string; ok?: boolean; dirty?: string; hub?: boolean; fetchFails?: boolean } = {}) {
    const git: Array<{ args: string[]; cwd?: string }> = []
    const inputs: RunnerInput[] = []
    const files = new Map<string, string>()
    const logs: string[] = []
    const deps: PlanDeps = {
      git: {
        run(args, opts): GitResult {
          git.push({ args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) })
          if (args[0] === 'status') return { code: 0, stdout: o.dirty ?? '', stderr: '' }
          if (o.fetchFails && (args[0] === 'fetch' || args[0] === 'clone')) return { code: 128, stdout: '', stderr: 'Could not resolve host' }
          return { code: 0, stdout: '', stderr: '' }
        },
      },
      runner: {
        run: async (input): Promise<RunnerResult> => {
          inputs.push(input)
          return { ok: o.ok ?? true, sessionId: 's', text: o.text ?? block(PLAN), costUsd: 0.4, turns: 3, stderrTail: [], timedOut: false }
        },
      },
      exists: p => (p.endsWith('/repo') ? o.hub ?? true : false),
      mkdirp: () => {},
      writeFile: (p, s) => { files.set(p, s) },
      now: () => Date.parse('2026-10-24T01:00:00Z'),
      log: l => { logs.push(l) },
      workdir: '/w', repoUrl: 'git@x:y.git', branch: 'dev', plansDir: '/state/self-plans', budgetUsd: 5, maxTurns: 40,
    }
    return { deps, git, inputs, files, logs }
  }

  it('fetch → 开 detached 的树 → 只读会话 → 存 json → 删树', async () => {
    const h = harness()
    const r = await runPlan(h.deps, { id: 'pl1', goal: '手机看自改进度' })
    expect(r.ok).toBe(true)
    expect(h.git.map(g => g.args.join(' '))).toEqual([
      'fetch origin --prune', 'worktree add --detach /w/plans/pl1 origin/dev', 'status --porcelain', 'worktree remove --force /w/plans/pl1',
    ])
    expect(h.inputs[0]).toMatchObject({ cwd: '/w/plans/pl1', readOnly: true, budgetUsd: 5, maxTurns: 40 })
    const saved = JSON.parse(h.files.get('/state/self-plans/pl1.json')!)
    expect(saved).toMatchObject({ id: 'pl1', goal: '手机看自改进度', order: ['p1', 'p2', 'p3'], costUsd: 0.4 })
    expect(r.message).toContain('要主人点头的:p3')
  })

  it('中枢还没有 ⇒ 先 clone', async () => {
    const h = harness({ hub: false })
    await runPlan(h.deps, { id: 'pl1', goal: 'g' })
    expect(h.git[0]).toEqual({ args: ['clone', 'git@x:y.git', 'repo'], cwd: '/w' })
  })

  it('拿不到最新 dev ⇒ 不调模型', async () => {
    const h = harness({ fetchFails: true })
    const r = await runPlan(h.deps, { id: 'pl1', goal: 'g' })
    expect(r.ok).toBe(false)
    expect(h.inputs).toHaveLength(0)
  })

  it('计划不成形 / 会话没跑完 ⇒ 不存、照样删树、带上它最后说的话', async () => {
    for (const o of [{ text: '我觉得先这样' }, { ok: false, text: 'network_unprotected' }]) {
      const h = harness(o)
      const r = await runPlan(h.deps, { id: 'pl1', goal: 'g' })
      expect(r.ok).toBe(false)
      expect(h.files.size).toBe(0)
      expect(h.git.at(-1)!.args.slice(0, 2)).toEqual(['worktree', 'remove'])
    }
  })

  it('只读会话动了树 ⇒ 照实说一声', async () => {
    const h = harness({ dirty: ' M src/a.ts' })
    expect((await runPlan(h.deps, { id: 'pl1', goal: 'g' })).ok).toBe(true)
    expect(h.logs.some(l => l.includes('动了只读的树') && l.includes('src/a.ts'))).toBe(true)
  })
})

describe('执行计划的一步', () => {
  const saved = (): SavedPlan => {
    const r = parsePlan(block(PLAN), '手机看自改进度')
    if (!r.ok) throw new Error(r.error)
    return { ...r.plan, id: 'pl1', createdAt: '2026-10-24T01:00:00Z', costUsd: 0.4, order: r.order }
  }
  const NOW = Date.parse('2026-10-24T03:00:00Z')

  it('依赖没做完不让做,并说现在能做哪步;做完一步,下一步解锁', () => {
    let plan = saved()
    expect(nextSteps(plan)).toEqual(['p1'])
    const blocked = stepGate(plan, 'p2', { ownerOk: false })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error).toContain('要等 p1')
    plan = markStepDone(plan, 'p1', 'run1', 'abc', NOW)
    expect(nextSteps(plan)).toEqual(['p2'])
    const ok = stepGate(plan, 'p2', { ownerOk: false })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.request).toContain('接口')
      expect(ok.request).toContain('为什么:给页用')
      expect(ok.request).toContain('计划 pl1 的 p2')
    }
  })

  it('主人看得见的那步:没有 --owner-ok 不让做;做过的、不存在的也不让', () => {
    let plan = markStepDone(markStepDone(saved(), 'p1', 'r1', null, NOW), 'p2', 'r2', null, NOW)
    const vis = stepGate(plan, 'p3', { ownerOk: false })
    expect(vis.ok).toBe(false)
    if (!vis.ok) expect(vis.error).toContain('--owner-ok')
    expect(stepGate(plan, 'p3', { ownerOk: true }).ok).toBe(true)
    const again = stepGate(plan, 'p1', { ownerOk: false })
    expect(!again.ok && again.error).toContain('已经做过了')
    const none = stepGate(plan, 'p9', { ownerOk: false })
    expect(!none.ok && none.error).toContain('没有 p9')
    plan = markStepDone(plan, 'p3', 'r3', null, NOW)
    expect(nextSteps(plan)).toEqual([])
  })

  it('人读版:做完的打勾,带「做完几步 / 现在能做」', () => {
    const plan = markStepDone(saved(), 'p1', 'r1', null, NOW)
    const t = formatPlan(plan, plan.order)
    expect(t).toContain('✓ p1')
    expect(t).toContain('做完 1 / 3;现在能做:p2')
  })
})
