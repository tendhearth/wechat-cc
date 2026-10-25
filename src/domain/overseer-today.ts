/**
 * overseer-today.ts — 「今天」一眼看完(2026-10-14):CC 统管主人所有编码 agent 的日报。
 *
 * 两路来源,一份结构:
 *   - 终端:主人在 CC 外面开的 Claude Code / Codex(cli_sessions 登记处,状态已按 stale 折算);
 *   - 一起做:CC 自己在工作台里做的事(workbench 任务,matter id = 任务 id)。
 *
 * 只读、只在被问时算(微信「日报」、GET /v1/overseer/today、手机 /m/api/today、CC 的工具
 * today_digest)—— 不定时、不主动发。纯函数:不碰库、不碰微信、不叫模型;同样的输入永远同样的输出。
 *
 * 时间窗:**过去 24 小时**(滚动),不是「本地零点以来」。主人最常在早上问,夜里跑完的那批正是
 * 他要看的;零点切会把它们切掉。滚动窗也不依赖 daemon 的时区设置(手机和电脑可能不在一个时区)。
 *
 * 四组(一件事只出现在一组里):
 *   needsYou — 在等主人拍板 / 回答:终端里等批准的 + 一起做里有待批权限或待答问题的。等得最久的在前。
 *   done     — 窗内做完一轮的:终端 Stop 之后闲着(或已结束、留了最后一句);一起做本轮已回复。新的在前。
 *   running  — 正在跑(非 stale)。新的在前。
 *   stuck    — 可能卡住:在跑 / 等批准却超过 30 分钟没动静;一起做窗内失败 / 中断。失败在前,再按新旧。
 * 「取消」是主人自己停的,不算卡住;窗外的旧事不出现。
 */
import type { CliDigestView } from './cli-session-digest'
import { cliSourceLabel, relativeTime, replyRefOf } from './cli-session-digest'
import { providerDisplayName } from './provider-display-names'

/** 时间窗:过去 24 小时(滚动)。 */
export const TODAY_WINDOW_MS = 24 * 3600_000
/** 在跑 / 等批准超过这么久没有任何事件 ⇒ 可能卡住(与终端登记处的 stale 同一个阈值)。 */
export const TODAY_QUIET_MS = 30 * 60_000
/** 一行摘要的长度上限。 */
const LINE_MAX = 48

export type TodaySource = 'terminal' | 'together'

export interface TodayItem {
  source: TodaySource
  /** 终端:会话 id;一起做:任务 id(= matter id,8 位 hex)。手机据此跳转。 */
  id: string
  /** 微信里怎么指它:终端是会话短码(「看 码」「@码」),一起做是任务编号(「任务 编号」)。 */
  code: string
  /** 只是目录名,从不给完整路径(手机口径同一条规矩)。 */
  project: string
  /** Claude Code / Codex / Cursor …;一起做的显示执行者。 */
  agent: string
  /** 一起做:任务标题;终端没有标题 ⇒ null。 */
  title: string | null
  /** 一行:做完的是最后一句,等你的是要批什么 / 问什么,卡住的是报错。 */
  summary: string | null
  /** 这一组排序用的时间:等你的是开始等的时刻,其余是最后一次动静。 */
  at: number
  /** 终端会话在别的电脑上 ⇒ 机器名;否则 null。 */
  machine: string | null
}
export interface TodayNeed extends TodayItem {
  kind: 'permission' | 'question'
  /** 这件里有几条在等(一起做一件事可能同时有几条)。 */
  count: number
  /** 微信里「y 码 / n 码」的码;主人在场、终端自己在问 ⇒ null。一起做恒为 null(用「任务 编号」)。 */
  replyRef: string | null
}
export interface TodayStuck extends TodayItem {
  reason: 'quiet' | 'failed' | 'interrupted'
}
export interface OverseerToday {
  generatedAt: number
  /** 窗口起点(generatedAt - 24h)。 */
  since: number
  windowHours: number
  needsYou: TodayNeed[]
  done: TodayItem[]
  running: TodayItem[]
  stuck: TodayStuck[]
  counts: { needsYou: number; done: number; running: number; stuck: number }
  /** 读不到的来源(登记处 / 工作台没接或出错)—— 数字不全,别当「没事」。 */
  unavailable: TodaySource[]
  /** 放行规则(2026-10-19):CC 替主人批了几条(规则 / 初审)+ 最近几条;null ⇒ 读不到 / 没接,不画。 */
  ccDecided: TodayCcDecided | null
  /** 定时任务(2026-10-20):过去 24 小时跑了几个、其中说了话的几个、被自动暂停的;null ⇒ 读不到 / 没接。 */
  jobs: TodayJobs | null
}

export interface TodayJobs { ran: number; spoke: number; paused: Array<{ id: string; text: string }> }

/** 一条 CC 替主人拿的权限决定(daemon 侧留痕表的那几列)。 */
export interface TodayCcDecision { at: number; surface: 'terminal' | 'workbench' | 'chat'; provider: string; tool: string; summary: string; verdict: 'allow' | 'deny'; by: 'rule' | 'review' | 'floor'; ruleId: string | null }
export interface TodayCcDecided { rule: number; review: number; recent: TodayCcDecision[] }

/** 工作台任务视图里用得到的那几个字段(WorkbenchTaskView 结构上满足)。 */
export interface TodayTaskInput {
  id: string
  title: string
  path: string
  providerId: string
  phase: 'queued' | 'working' | 'replied' | 'failed' | 'cancelled' | 'interrupted'
  updatedAt: number
  error: string | null
  archivedAt: number | null
  pendingPermissionCount?: number
  pendingQuestionCount?: number
}
/** 工作台 attention() 的一条(有待批权限 / 待答问题的任务)。 */
export interface TodayAttentionInput {
  id: string
  title: string
  providerId: string
  pendingPermissionCount: number
  pendingQuestionCount: number
  first: { kind: 'permission' | 'question'; text: string } | null
}
export interface OverseerTodayInput {
  now: number
  /** 终端登记处(含已结束的);null ⇒ 读不到。 */
  terminal: readonly CliDigestView[] | null
  /** 工作台未归档任务;null ⇒ 读不到。 */
  tasks: readonly TodayTaskInput[] | null
  /** 工作台待决;null ⇒ 读不到(此时从 tasks 的 pending 计数兜底)。 */
  attention: readonly TodayAttentionInput[] | null
  /** daemon 所在机器;终端会话不在这台 ⇒ 标机器名。 */
  localMachine?: string | undefined
  /** 放行规则的留痕(窗口内);缺省 / null ⇒ 读不到。 */
  ccDecided?: TodayCcDecided | null
  jobs?: TodayJobs | null
}


function oneLine(text: string | null | undefined, max = LINE_MAX): string | null {
  if (!text) return null
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}
function dirName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function buildOverseerToday(input: OverseerTodayInput): OverseerToday {
  const now = input.now
  const since = now - TODAY_WINDOW_MS
  const needsYou: TodayNeed[] = [], done: TodayItem[] = [], running: TodayItem[] = [], stuck: TodayStuck[] = []
  const unavailable: TodaySource[] = []

  // ── 终端 ──
  if (input.terminal === null) unavailable.push('terminal')
  for (const v of input.terminal ?? []) {
    const base: TodayItem = {
      source: 'terminal', id: v.session_id, code: v.code, project: v.project, agent: cliSourceLabel(v.source), title: null,
      summary: oneLine(v.last_summary), at: v.last_event_at,
      machine: v.machine && input.localMachine && v.machine !== input.localMachine ? v.machine : null,
    }
    if (v.status === 'waiting' && v.pending) {
      const tool = v.pending.tool === 'permission' ? '' : v.pending.tool
      needsYou.push({ ...base, kind: 'permission', count: 1, replyRef: replyRefOf(v), at: v.pending.since, summary: oneLine([tool, v.pending.summary ?? ''].filter(Boolean).join(': ')) })
    } else if (v.status === 'running') {
      running.push(base)
    } else if (v.status === 'idle' && v.stale) {
      // 库里是 running / waiting,但 30 分钟没事件:可能卡住,也可能终端被关了 —— 窗外的不提。
      if (v.last_event_at >= since) stuck.push({ ...base, reason: 'quiet' })
    } else if (v.status === 'idle' || (v.status === 'ended' && v.last_summary)) {
      if (v.last_event_at >= since) done.push(base)
    }
  }

  // ── 一起做 ──
  if (input.tasks === null) unavailable.push('together')
  const tasks = input.tasks ?? []
  const taskById = new Map(tasks.map(t => [t.id, t]))
  const waitingIds = new Set<string>()
  const togetherBase = (t: { id: string; title: string; providerId: string }, at: number, summary: string | null): TodayItem => {
    const full = taskById.get(t.id)
    return { source: 'together', id: t.id, code: t.id, project: full ? dirName(full.path) : '', agent: providerDisplayName(full?.providerId ?? t.providerId), title: oneLine(t.title), summary, at, machine: null }
  }
  if (input.attention) {
    for (const a of input.attention) {
      const count = a.pendingPermissionCount + a.pendingQuestionCount
      if (count <= 0) continue
      waitingIds.add(a.id)
      const kind = a.first?.kind ?? (a.pendingPermissionCount > 0 ? 'permission' : 'question')
      needsYou.push({ ...togetherBase(a, taskById.get(a.id)?.updatedAt ?? now, oneLine(a.first?.text)), kind, count, replyRef: null })
    }
  } else {
    // attention 读不到:从任务视图上的计数兜底(没有「第一件」的原文)。
    for (const t of tasks) {
      const p = t.pendingPermissionCount ?? 0, q = t.pendingQuestionCount ?? 0
      if (p + q <= 0) continue
      waitingIds.add(t.id)
      needsYou.push({ ...togetherBase(t, t.updatedAt, null), kind: p > 0 ? 'permission' : 'question', count: p + q, replyRef: null })
    }
  }
  for (const t of tasks) {
    if (t.archivedAt !== null || waitingIds.has(t.id)) continue
    switch (t.phase) {
      case 'queued': case 'working':
        if (t.phase === 'working' && now - t.updatedAt > TODAY_QUIET_MS) stuck.push({ ...togetherBase(t, t.updatedAt, null), reason: 'quiet' })
        else running.push(togetherBase(t, t.updatedAt, null))
        break
      case 'replied':
        if (t.updatedAt >= since) done.push(togetherBase(t, t.updatedAt, null))
        break
      case 'failed': case 'interrupted':
        if (t.updatedAt >= since) stuck.push({ ...togetherBase(t, t.updatedAt, oneLine(t.error)), reason: t.phase })
        break
      case 'cancelled': break   // 主人自己停的
    }
  }

  // 排序:等你的 —— 等得最久的在前;做完 / 在跑 —— 新的在前;卡住 —— 失败 / 中断在前,再新的在前。同时刻按 id 定序。
  const byId = (a: TodayItem, b: TodayItem) => a.id.localeCompare(b.id)
  needsYou.sort((a, b) => a.at - b.at || byId(a, b))
  done.sort((a, b) => b.at - a.at || byId(a, b))
  running.sort((a, b) => b.at - a.at || byId(a, b))
  const rank = (s: TodayStuck) => (s.reason === 'quiet' ? 1 : 0)
  stuck.sort((a, b) => rank(a) - rank(b) || b.at - a.at || byId(a, b))

  return {
    generatedAt: now, since, windowHours: TODAY_WINDOW_MS / 3600_000,
    needsYou, done, running, stuck,
    counts: { needsYou: needsYou.length, done: done.length, running: running.length, stuck: stuck.length },
    unavailable,
    ccDecided: input.ccDecided ?? null,
    jobs: input.jobs ?? null,
  }
}

// ── 微信纯文本 ─────────────────────────────────────────────────────────────

/** 整条最多这么多行(微信一屏)。 */
export const TODAY_TEXT_MAX_LINES = 15
/** 每组最多列几条:1 行标题 + 4 + 2 + 4 + 2 + 1 行「没列出的」+ 1 行提示 = 15。 */
/** 日报里「等你」最多列几件(早报给候选编号时从它之后接着排)。 */
export const OVERSEER_NEEDS_SHOWN = 4
const MAX_NEEDS = OVERSEER_NEEDS_SHOWN, MAX_STUCK = 2, MAX_DONE = 4, MAX_RUNNING = 2

/** withCode=false:那一行后面已经写了「回「任务 编号」」,一起做这里就不再重复编号。 */
function where(i: TodayItem, withCode = true): string {
  const name = i.source === 'together' ? (i.title || i.project || '一件事') : (i.project || '终端')
  const remote = i.machine ? `(${i.machine})` : ''
  return `${name}${remote} · ${i.source === 'together' ? (withCode ? `一起做 ${i.code}` : '一起做') : `${i.agent} · 码 ${i.code}`}`
}

/** 「45 分钟 / 3 小时 / 2 天」—— 多久没动静。 */
function quietFor(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000))
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} 小时` : `${Math.floor(h / 24)} 天`
}

function needLine(n: TodayNeed, now: number): string {
  const what = n.summary ? ` · ${n.summary}` : ''
  const act = n.source === 'terminal'
    ? (n.replyRef ? `回「y ${n.replyRef}」/「n ${n.replyRef}」` : '回终端处理')
    : `回「任务 ${n.code}」看详情`
  const many = n.count > 1 ? `(${n.count} 条)` : ''
  return `等你 · ${where(n, n.source !== 'together')}${many}${what} · ${relativeTime(n.at, now)} · ${act}`
}

/** 「CC 替你批了 3 条(规则 2、初审 1)」;全 0 / 读不到 ⇒ ''。 */
function ccLine(d: TodayCcDecided | null): string {
  if (!d || d.rule + d.review === 0) return ''
  const parts = [d.rule ? `规则 ${d.rule}` : '', d.review ? `初审 ${d.review}` : ''].filter(Boolean).join('、')
  return `CC 替你批了 ${d.rule + d.review} 条(${parts})`
}

/**
 * 主人发「日报」时回的那条:纯文本(微信不认 markdown),等你的在最前,≤ 15 行。
 * 第一行是几个数;每组只列前几条,没列出的合成一行;最后一行是怎么接着操作(只提列出来的那几种)。
 */
export function formatOverseerToday(t: OverseerToday, opts: { now?: number } = {}): string {
  const now = opts.now ?? t.generatedAt
  const c = t.counts
  const gap = t.unavailable.length
    ? `(${t.unavailable.map(s => (s === 'terminal' ? '终端' : '一起做')).join('、')}暂时读不到)`
    : ''
  const cc = ccLine(t.ccDecided)
  const jobsRan = t.jobs && t.jobs.ran > 0 ? `定时 ${t.jobs.ran} 个(说了 ${t.jobs.spoke} 个)` : ''
  const jobsPaused = t.jobs?.paused.length ? t.jobs.paused.map(p => `定时 ${p.id}「${[...p.text].slice(0, 12).join('')}」连着没跑成,停了`).join(';') + '(发「定时 开 编号」再开)' : ''
  if (c.needsYou + c.done + c.running + c.stuck === 0) {
    return `过去 24 小时没有新动静:终端和一起做都没有在跑、等你或做完的事。${gap}${[cc, jobsRan, jobsPaused].filter(Boolean).map(l => `\n${l}`).join('')}`
  }
  // 是 0 的不写;「N 件事等你」和桌面 / 手机「此刻」同一个说法。CC 替你批的并进第一行(整条仍 ≤ 15 行)。
  const head = [c.needsYou ? `${c.needsYou} 件事等你` : '', c.done ? `${c.done} 件做完` : '', c.running ? `${c.running} 件在跑` : '', c.stuck ? `${c.stuck} 件可能卡住` : '', cc, jobsRan].filter(Boolean).join(' · ')
  const lines: string[] = [`今天(过去 24 小时):${head}${gap}`]
  if (jobsPaused) lines.push(jobsPaused)

  const needs = t.needsYou.slice(0, MAX_NEEDS), stuck = t.stuck.slice(0, MAX_STUCK)
  const done = t.done.slice(0, MAX_DONE), running = t.running.slice(0, MAX_RUNNING)
  for (const n of needs) lines.push(needLine(n, now))
  for (const s of stuck) {
    const why = s.reason === 'quiet' ? `${quietFor(now - s.at)}没动静` : s.reason === 'failed' ? '失败了' : '中断了'
    lines.push(`卡住 · ${where(s)} · ${why}${s.summary ? ` · ${s.summary}` : ''}`)
  }
  for (const d of done) lines.push(`做完 · ${where(d)} · ${relativeTime(d.at, now)}${d.summary ? ` · ${d.summary}` : ''}`)
  for (const r of running) lines.push(`在跑 · ${where(r)} · ${relativeTime(r.at, now)}有动静`)

  const left = [
    [t.needsYou.length - needs.length, '事等你'], [t.stuck.length - stuck.length, '可能卡住'],
    [t.done.length - done.length, '做完'], [t.running.length - running.length, '在跑'],
  ].filter(([n]) => (n as number) > 0).map(([n, w]) => `${n} 件${w}`)
  if (left.length) lines.push(`(没列出的:${left.join('、')})`)

  const shown = [...needs, ...stuck, ...done, ...running]
  const hints: string[] = []
  if (shown.some(i => i.source === 'terminal')) hints.push('「看 码」看终端对话', '「@码 话」接着说')
  if (shown.some(i => i.source === 'together')) hints.push('「任务 编号」看一起做')
  if (hints.length) lines.push(hints.join(','))
  return lines.join('\n')
}
