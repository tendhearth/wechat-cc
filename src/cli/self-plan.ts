/**
 * self-plan.ts —— `wechat-cc self plan "<目标>"`:把一个开发目标变成一份计划(要改什么、拆成几个 PR、先后依赖、
 * 哪些改动主人看得见)。设计稿 2026-10-23-cc-runs-development §4.2 的「规划者」、§6 第 6 步的 CLI 那一半。
 *
 * 两路会话这些天每接一件整活,先做的都是这件事:读代码和 docs,写「拆成几个 PR、谁先谁后、哪一步要主人点头」。
 * 对标:Claude Code 的 plan 模式 / `/goal`、Devin 的 planning、Codex 的任务拆分 —— 先出计划、人看过再动手。
 * 跟它们不一样的两条:**计划是数据**(JSON,代码校验 id 唯一、依赖都在、没有环,按依赖排好序),不是一段散文;
 * **主人看得见的改动逐条标出来**,那些 PR 停在设计稿等点头(做法清单「看得见的变化逐条问」)。
 *
 * 只读:在中枢克隆里开一棵 detached 的树(站在 origin/dev 上),规划者用只读会话跑(关掉写工具),跑完查一遍树没被动过,
 * 树删掉。网络守护照旧在调模型之前看(guardedRunner)。产出存 `<stateDir>/self-plans/<id>.json`,人读版打到终端。
 * 执行一步:`self change --plan <id> --step <p1>`(stepGate:依赖没做完不让做、主人看得见的要 `--owner-ok`);做完记回计划文件
 * 的 `done`,`--show` 打勾、列出现在能做的。自动一步步跑下去、并行、`dev_goal` 那件事、三端看进度是第 7、8 步,在核心链之后。
 */
import type { Git } from './self-change/git'
import type { ImplementRunner } from './self-change/runner'
import type { EnqueueInput } from '../domain/owner-asks'

export interface PlanPr {
  /** 计划里的编号(p1、p2…),依赖靠它。 */
  id: string
  title: string
  /** 为什么要这一步、对主人意味着什么。 */
  why: string
  /** 大概会动的地方(文件 / 目录),给执行者和评审起个头;不是禁改清单。 */
  scope: string[]
  dependsOn: string[]
  /** 主人天天看得见的行为变了 ⇒ true:这一步先停在设计稿等主人点头。 */
  visible: boolean
  /** 怎么证明做对了(测试、守卫、真机核对)。 */
  verify: string
}

export interface DevPlan {
  goal: string
  summary: string
  /** 改动大到要先写设计稿(设计稿本身是第一个 PR)。 */
  designFirst: boolean
  prs: PlanPr[]
  /** 规划者拿不准、要主人回答的问题(带选项和推荐)。 */
  questions: string[]
}

/** 存盘的计划:DevPlan + 号、时间、花费、排好的顺序、做完了哪几步。 */
export interface SavedPlan extends DevPlan {
  id: string
  createdAt: string
  costUsd: number
  order: string[]
  /** 做完的步:哪条自改做的、合进去的提交。 */
  done?: Record<string, { run: string; merge: string | null; at: string }>
}

export type PlanParse = { ok: true; plan: DevPlan; order: string[] } | { ok: false; error: string }

const JSON_BLOCK = /```json\s*\n([\s\S]*?)\n```/g
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])

/** 依赖排序(Kahn);有环 ⇒ null。同层按计划里出现的先后。 */
export function topoOrder(prs: Array<Pick<PlanPr, 'id' | 'dependsOn'>>): string[] | null {
  const indeg = new Map(prs.map(p => [p.id, p.dependsOn.length]))
  const out: string[] = []
  const ready = prs.filter(p => p.dependsOn.length === 0).map(p => p.id)
  while (ready.length) {
    const id = ready.shift()!
    out.push(id)
    for (const p of prs) {
      if (!p.dependsOn.includes(id)) continue
      const n = (indeg.get(p.id) ?? 0) - 1
      indeg.set(p.id, n)
      if (n === 0) ready.push(p.id)
    }
  }
  return out.length === prs.length ? out : null
}

/** 取规划者最后一个 ```json 块(或者整段就是一个对象),校验成 DevPlan。 */
export function parsePlan(text: string, goal: string): PlanParse {
  const blocks = [...text.matchAll(JSON_BLOCK)].map(m => m[1] ?? '')
  const bare = text.trim()
  const raw = blocks.at(-1) ?? (bare.startsWith('{') && bare.endsWith('}') ? bare : undefined)
  if (raw === undefined) return { ok: false, error: '规划者最后没有给出 ```json 的计划' }
  let obj: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: '计划不是一个 JSON 对象' }
    obj = v as Record<string, unknown>
  } catch (e) {
    return { ok: false, error: `计划的 JSON 解析不了:${(e as Error).message}` }
  }
  const rawPrs = Array.isArray(obj.prs) ? obj.prs : []
  if (!rawPrs.length) return { ok: false, error: '计划里一个 PR 都没有' }
  const prs: PlanPr[] = rawPrs.map((r, i) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    return {
      id: str(o.id) || `p${i + 1}`,
      title: str(o.title),
      why: str(o.why),
      scope: strs(o.scope),
      dependsOn: strs(o.dependsOn),
      visible: o.visible === true,
      verify: str(o.verify),
    }
  })
  const ids = new Set<string>()
  for (const p of prs) {
    if (!p.title) return { ok: false, error: `${p.id} 没有标题` }
    if (ids.has(p.id)) return { ok: false, error: `PR 编号重复:${p.id}` }
    ids.add(p.id)
  }
  for (const p of prs) {
    const unknown = p.dependsOn.filter(d => !ids.has(d))
    if (unknown.length) return { ok: false, error: `${p.id} 依赖了不存在的 ${unknown.join('、')}` }
    if (p.dependsOn.includes(p.id)) return { ok: false, error: `${p.id} 依赖了自己` }
  }
  const order = topoOrder(prs)
  if (!order) return { ok: false, error: '依赖成环了,排不出先后' }
  return {
    ok: true,
    order,
    plan: { goal, summary: str(obj.summary), designFirst: obj.designFirst === true, prs, questions: strs(obj.questions) },
  }
}

/** 给规划者的那段话。规矩不抄进来,让它去读仓库里那几份(读的是这棵树站着的 origin/dev 版本)。 */
export function planPrompt(o: { goal: string; branch: string; candidates?: string }): string {
  return [
    `你是 Tendhearth CC 的规划者。这棵树是 origin/${o.branch} 的只读检出:只读代码和文档,不改任何文件。`,
    '',
    `开发目标:${o.goal}`,
    '',
    '先读:AGENTS.md、docs/maintainer/README.md、docs/maintainer/practices.md(做法清单,每条都要守)、docs/roadmap.md、和目标相关的 docs/superpowers/specs/ 与代码。',
    '',
    '要产出一份计划:',
    '- 拆成几个 PR,每个只做一件事、单独能合、单独能停;重构 / 修 bug 跟主人看得见的改动分开。',
    '- 写清先后:dependsOn 只写真的依赖(要用到上一个 PR 的代码),能并行的别串起来。',
    '- 主人天天看得见的行为变了(微信里说的话、App / 桌面的界面、默认开关)⇒ visible: true,那一步先写设计稿等主人点头。',
    '- 改动大(跨三个以上模块、动迁移或协议、动开机 / 关机顺序)⇒ designFirst: true,第一个 PR 就是设计稿。',
    '- 每个 PR 写怎么证明做对了:哪些测试、哪个守卫、要不要真机核对。',
    '- 拿不准、要主人定的,写进 questions(写清选项和你的推荐);能自己定的别问。',
    '- 先核对代码里是不是已经有了,有了就别再计划一遍。',
    ...(o.candidates ? ['', '`self discover` 现在摆出来的候选(真机信号 / 欠账 / 对标),相关的可以并进计划,不相关的别管:', o.candidates] : []),
    '',
    '最后只回一个 ```json 块,形状:',
    '```json',
    '{"summary":"一两句话:做完对主人意味着什么","designFirst":false,"prs":[{"id":"p1","title":"…","why":"…","scope":["src/…"],"dependsOn":[],"visible":false,"verify":"…"}],"questions":[]}',
    '```',
  ].join('\n')
}

/** 依赖都做完、自己还没做的那几步(按计划顺序)。 */
export function nextSteps(plan: SavedPlan): string[] {
  const done = plan.done ?? {}
  const byId = new Map(plan.prs.map(p => [p.id, p]))
  return plan.order.filter(id => !done[id] && byId.get(id)!.dependsOn.every(d => done[d]))
}

/** 交给 `self change` 的需求原文:标题 + 为什么 + 范围 + 怎么证明 + 出处。 */
export function stepRequest(plan: SavedPlan, pr: PlanPr): string {
  return [
    pr.title,
    '',
    ...(pr.why ? [`为什么:${pr.why}`] : []),
    ...(pr.scope.length ? [`大概动:${pr.scope.join('、')}`] : []),
    ...(pr.verify ? [`怎么证明:${pr.verify}`] : []),
    `(计划 ${plan.id} 的 ${pr.id};整件的目标:${plan.goal})`,
  ].join('\n')
}

/**
 * 能不能做这一步:没这一步、做过了、依赖没做完 ⇒ 不让;主人看得见的(visible)⇒ 要 `ownerOk`
 * (做法清单「看得见的变化逐条问」:先写设计稿,主人点过头才动手)。
 */
export function stepGate(plan: SavedPlan, step: string, o: { ownerOk: boolean }): { ok: true; pr: PlanPr; request: string } | { ok: false; error: string } {
  const pr = plan.prs.find(p => p.id === step)
  if (!pr) return { ok: false, error: `计划 ${plan.id} 里没有 ${step}(有:${plan.order.join('、')})` }
  const done = plan.done ?? {}
  if (done[step]) return { ok: false, error: `${step} 已经做过了(自改 #${done[step]!.run})` }
  const waiting = pr.dependsOn.filter(d => !done[d])
  if (waiting.length) return { ok: false, error: `${step} 要等 ${waiting.join('、')} 先做完;现在能做的:${nextSteps(plan).join('、') || '(没有)'}` }
  if (pr.visible && !o.ownerOk) return { ok: false, error: `${step} 会改主人看得见的东西:先写设计稿等主人点头,点过头再加 --owner-ok` }
  return { ok: true, pr, request: stepRequest(plan, pr) }
}

export function markStepDone(plan: SavedPlan, step: string, run: string, merge: string | null, now: number): SavedPlan {
  return { ...plan, done: { ...(plan.done ?? {}), [step]: { run, merge, at: new Date(now).toISOString() } } }
}

export function formatPlan(plan: DevPlan & { done?: SavedPlan['done']; id?: string }, order: string[]): string {
  const byId = new Map(plan.prs.map(p => [p.id, p]))
  const done = plan.done ?? {}
  const out = [`计划:${plan.goal}`, plan.summary ? `  ${plan.summary}` : '', plan.designFirst ? '  先写设计稿(第一个 PR)' : ''].filter(Boolean)
  out.push('', `  ${plan.prs.length} 个 PR(按依赖排好的顺序):`)
  for (const id of order) {
    const p = byId.get(id)!
    out.push(`  ${done[id] ? '✓' : ' '} ${p.id}  ${p.title}${p.visible ? '  [主人看得见 ⇒ 先停在设计稿等点头]' : ''}${p.dependsOn.length ? `  (在 ${p.dependsOn.join('、')} 之后)` : ''}`)
    if (p.why) out.push(`        为什么:${p.why}`)
    if (p.scope.length) out.push(`        大概动:${p.scope.join('、')}`)
    if (p.verify) out.push(`        怎么证明:${p.verify}`)
  }
  if (plan.id && Object.keys(done).length) {
    const next = nextSteps({ ...plan, id: plan.id, createdAt: '', costUsd: 0, order } as SavedPlan)
    out.push('', `  做完 ${Object.keys(done).length} / ${plan.prs.length};现在能做:${next.join('、') || '(都做完了)'}`)
  }
  const visible = plan.prs.filter(p => p.visible)
  if (visible.length) out.push('', `  要主人点头的:${visible.map(p => p.id).join('、')}`)
  if (plan.questions.length) out.push('', '  要主人回答的:', ...plan.questions.map(q => `  - ${q}`))
  return out.join('\n')
}

/**
 * 计划里主人看得见的那几步 ⇒ 要主人拍板的候选(`self plan --ask`;设计稿 §4.8 / §6 第 5 步)。
 * 一步一条,key = `plan:<计划>:<步>`;版本 = 整份计划的 PR 列表 —— 计划改过,批过的那版就不算数,要重批(§6 第 7 步)。
 */
export function planVisibleAsks(plan: Pick<SavedPlan, 'id' | 'goal' | 'prs'>): EnqueueInput[] {
  const version = JSON.stringify({ goal: plan.goal, prs: plan.prs })
  return plan.prs.filter(p => p.visible).map(p => ({
    key: `plan:${plan.id}:${p.id}`,
    question: `要不要做:${p.title.replace(/[??。.]+$/, '')}?`,
    recommend: `做。${p.why}`,
    evidence: `计划 ${plan.id}「${plan.goal}」的 ${p.id};怎么验:${p.verify}`,
    source: 'plan' as const,
    version,
  }))
}

export interface PlanDeps {
  git: Git
  runner: ImplementRunner
  exists: (p: string) => boolean
  mkdirp: (p: string) => void
  writeFile: (p: string, s: string) => void
  now: () => number
  log: (line: string) => void
  /** 自改的工作目录(中枢克隆在 `<workdir>/repo`,计划的树开在 `<workdir>/plans/<id>`)。 */
  workdir: string
  repoUrl: string
  branch: string
  /** 计划存在 `<plansDir>/<id>.json`。 */
  plansDir: string
  budgetUsd: number
  maxTurns: number
}

export interface PlanRunResult {
  ok: boolean
  id: string
  message: string
  plan?: DevPlan
  order?: string[]
  costUsd: number
  path?: string
}

const NETWORK_TIMEOUT_MS = 10 * 60_000

export async function runPlan(d: PlanDeps, o: { id: string; goal: string; candidates?: string }): Promise<PlanRunResult> {
  const hub = `${d.workdir}/repo`
  const tree = `${d.workdir}/plans/${o.id}`
  const g = (cwd: string, args: string[], timeoutMs?: number) => d.git.run(args, { cwd, ...(timeoutMs ? { timeoutMs } : {}) })
  const fail = (message: string, costUsd = 0): PlanRunResult => ({ ok: false, id: o.id, message, costUsd })

  d.mkdirp(`${d.workdir}/plans`)
  const sync = d.exists(hub) ? g(hub, ['fetch', 'origin', '--prune'], NETWORK_TIMEOUT_MS) : g(d.workdir, ['clone', d.repoUrl, 'repo'], NETWORK_TIMEOUT_MS)
  if (sync.code !== 0) return fail(`拿不到最新的 ${d.branch}:${sync.stderr.trim().slice(0, 300)}`)
  const add = g(hub, ['worktree', 'add', '--detach', tree, `origin/${d.branch}`])
  if (add.code !== 0) return fail(`开不出只读的树:${add.stderr.trim().slice(0, 300)}`)
  try {
    const r = await d.runner.run({ cwd: tree, prompt: planPrompt({ goal: o.goal, branch: d.branch, ...(o.candidates ? { candidates: o.candidates } : {}) }), readOnly: true, budgetUsd: d.budgetUsd, maxTurns: d.maxTurns })
    if (!r.ok) return fail(`规划者没跑完${r.error ? `(${r.error})` : ''}:${r.text.slice(0, 300)}`, r.costUsd)
    // 只读会话动了树 ⇒ 计划照收,但照实说(它不该写,写了说明提示词或工具没关住)。
    const dirty = g(tree, ['status', '--porcelain']).stdout.trim()
    if (dirty) d.log(`注意:规划者动了只读的树(已丢弃):\n${dirty.split('\n').slice(0, 10).join('\n')}`)
    const parsed = parsePlan(r.text, o.goal)
    if (!parsed.ok) return fail(`计划不成形:${parsed.error}。规划者最后说的是:\n${r.text.slice(-600)}`, r.costUsd)
    d.mkdirp(d.plansDir)
    const path = `${d.plansDir}/${o.id}.json`
    d.writeFile(path, JSON.stringify({ id: o.id, createdAt: new Date(d.now()).toISOString(), costUsd: r.costUsd, order: parsed.order, ...parsed.plan }, null, 2))
    return { ok: true, id: o.id, message: formatPlan(parsed.plan, parsed.order), plan: parsed.plan, order: parsed.order, costUsd: r.costUsd, path }
  } finally {
    g(hub, ['worktree', 'remove', '--force', tree])
  }
}
