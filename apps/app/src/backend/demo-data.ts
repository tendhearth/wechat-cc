import type { Lang } from '../i18n'
import type { ApprovalExplanationT, ProgressSummaryT, PhoneChangesTurnT, EntryOptionsT, ConnectionsT, NativeSessionRowT, NativeSessionPageT } from './types'

/** 演示情境的文案(中英两份,照设计样稿 tendhearth-phone.html 的 tr('中','英'))。 */
type Pair = readonly [zh: string, en: string]
const pick = (lang: Lang, p: Pair) => (lang === 'zh-Hans' ? p[0] : p[1])

export const IDS = { portfolio: 'a1b2c3d4', notes: 'e5f6a7b8', trip: 'c9d0e1f2' } as const
/** 主人和 CC 的那条对话(chat matter;Task 10 起不进「一起做」,单独置顶)。 */
export const CHAT_ID = 'c0ffee01'
export const PERM_ID = 'perm-demo-1'
export const QUESTION_ID = 'q-demo-1'
export const RUN_IDS = { [IDS.portfolio]: 'run-demo-1', [IDS.trip]: 'run-demo-3' } as Record<string, string>

export const copy = {
  portfolioTitle: ['让作品集在手机上更好看', 'A better portfolio on mobile'],
  notesTitle: ['把零散想法收一收', 'A home for loose ideas'],
  tripTitle: ['整理下周出差安排', 'Plan next week’s trip'],
  ev1: ['看过现有首页', 'Reviewed the current homepage'],
  ev2: ['调整手机上的布局', 'Refined the mobile layout'],
  evAllowed: ['已允许：安装图片处理组件', 'Allowed: add the image-processing package'],
  evDenied: ['先不做', 'Not now'],
  evDone: ['图片处理完成', 'Image processing finished'],
  evAnswered: ['已回答：', 'Answered: '],
  ccReply: ['收到，我来看看。', 'Got it, I’ll take a look.'],
  creating: ['收到，正在整理。', 'Got it, working on it.'],
  created: ['整理好了，这一轮已回复。', 'All set; this round is replied.'],
  title: ['可以安装图片处理组件吗？', 'May I add an image-processing package?'],
  what: ['安装 sharp 图片处理组件。', 'Install the sharp image-processing package.'],
  scope: ['作品集项目的依赖文件。', 'The dependency files in your Portfolio project.'],
  effect: ['联网下载软件包，可能运行安装脚本，并更新项目的依赖记录。', 'Downloads packages, may run installation scripts, and updates the project’s dependency records.'],
  sumPending: ['布局已经理顺了。为了让图片更轻、更清楚，有一步想先问问你。', 'The layout is coming together. Before I make the images lighter and sharper, there’s one step to check with you.'],
  sumWorking: ['收到，我会继续处理图片，再检查手机上的效果。', 'Got it. I’ll work on the images, then check how they look on a phone.'],
  sumDenied: ['这一步先不做。你可以告诉我想换个什么办法。', 'I’ve paused this step. Tell me if you’d like a different approach.'],
  sumDone: ['图片处理好了，手机上的效果也检查过了。', 'The images are done and I checked how they look on a phone.'],
  step1d: ['保留暖色和原来的内容', 'Keeping the warm colors and existing content'],
  step2d: ['标题、留白和按钮的位置', 'Headings, spacing, and button placement'],
  step3Pending: ['图片处理，等你决定', 'Image processing awaits your decision'],
  step3PendingD: ['需要安装一个组件', 'A package needs to be installed'],
  step3Working: ['继续处理图片', 'Working on the images'],
  step3Paused: ['图片处理暂缓', 'Image processing is paused'],
  step3D: ['有新进展会告诉你', 'I’ll let you know what comes next'],
  step3Done: ['图片处理完成', 'Image processing finished'],
  step3DoneD: ['图片更轻、更清楚了', 'The images are lighter and sharper'],
  qHeader: ['出发时间', 'Departure'],
  qText: ['去哪天出发？', 'Which day do you leave?'],
  optMon: ['周一', 'Monday'],
  optTue: ['周二', 'Tuesday'],
  tripSumAsk: ['行程大致排好了，只差出发日期想先问问你。', 'The itinerary is mostly set; I just need to know your departure day.'],
  tripSumDone: ['出发日期定了，行程已经整理好。', 'Departure day is set and the itinerary is sorted.'],
  stepTrip1: ['列出要见的人和地点', 'Listed who and where'],
  stepTrip1d: ['按天排开', 'Laid out by day'],
  stepTripAsk: ['出发日期，等你回答', 'Departure day awaits your answer'],
  stepTripAskD: ['一个小问题', 'One quick question'],
  projPortfolio: ['作品集', 'Portfolio'],
  auto: ['由 CC 安排', 'Let CC choose'],
  home: ['家里的电脑', 'Home computer'],
  chatTitle: ['和 CC 的对话', 'You & CC'],
  chatSeed1: ['今天降温了，出门记得加件外套。', 'It’s colder today. Take a jacket.'],
  chatSeed2: ['好，谢谢提醒', 'Will do, thanks'],
  chatSeed3: ['作品集那件我先放着，明天接着看？', 'Shall I park the portfolio and pick it up tomorrow?'],
  chatSeed4: ['可以', 'Sounds good'],
  chatDemoReply: ['收到。这是演示模式，真连上你的电脑后，这里就是 CC 本人在回你。', 'Got it. This is the demo; once you pair with your computer, CC itself replies here.'],
  sessPortfolio: ['首页在手机上排版乱了', 'Homepage layout breaks on mobile'],
  sessNotes: ['把笔记按主题归一下', 'Group my notes by topic'],
  sessTrip: ['给出差行程加个打包清单', 'Add a packing list to the trip planner'],
  sessQ1: ['帮我看看为什么手机上会横向滚动。', 'Can you see why it scrolls sideways on a phone?'],
  sessA1: ['是首屏图片的固定宽度撑出来的，我改成了按屏幕宽度缩放。', 'The hero image had a fixed width; I made it scale with the screen.'],
  sessQ2: ['好，顺便把标题字号也调小一点。', 'Great, make the heading a little smaller too.'],
} satisfies Record<string, Pair>

export const t = (lang: Lang, k: keyof typeof copy) => pick(lang, copy[k])

export type Stage = 'pending' | 'working' | 'replied' | 'denied' | 'ask' | 'answered'

export function explanation(lang: Lang): ApprovalExplanationT {
  return { title: t(lang, 'title'), what: t(lang, 'what'), scope: t(lang, 'scope'), effect: t(lang, 'effect'), source: 'model' }
}

export function progress(lang: Lang, id: string, stage: Stage): ProgressSummaryT | null {
  const s1 = { title: t(lang, 'ev1'), detail: t(lang, 'step1d') }
  const s2 = { title: t(lang, 'ev2'), detail: t(lang, 'step2d') }
  if (id === IDS.portfolio) {
    switch (stage) {
      case 'pending': return { summary: t(lang, 'sumPending'), steps: [s1, s2, { title: t(lang, 'step3Pending'), detail: t(lang, 'step3PendingD') }], source: 'model' }
      case 'denied': return { summary: t(lang, 'sumDenied'), steps: [s1, s2, { title: t(lang, 'step3Paused'), detail: t(lang, 'step3D') }], source: 'model' }
      case 'working': return { summary: t(lang, 'sumWorking'), steps: [s1, s2, { title: t(lang, 'step3Working'), detail: t(lang, 'step3D') }], source: 'model' }
      default: return { summary: t(lang, 'sumDone'), steps: [s1, s2, { title: t(lang, 'step3Done'), detail: t(lang, 'step3DoneD') }], source: 'model' }
    }
  }
  if (id === IDS.trip) {
    const t1 = { title: t(lang, 'stepTrip1'), detail: t(lang, 'stepTrip1d') }
    return stage === 'ask'
      ? { summary: t(lang, 'tripSumAsk'), steps: [t1, { title: t(lang, 'stepTripAsk'), detail: t(lang, 'stepTripAskD') }], source: 'model' }
      : { summary: t(lang, 'tripSumDone'), steps: [t1, { title: t(lang, 'step3Working'), detail: t(lang, 'step3D') }], source: 'model' }
  }
  return null
}

export function changesTurn(now: number): PhoneChangesTurnT {
  return {
    createdAt: now, status: 'complete', omittedFiles: 0, notes: [],
    files: [
      { path: 'src/pages/home.css', kind: 'modified', truncated: false, diff: '-  padding: 64px 48px;\n+  padding: 32px 20px;\n+  max-width: 100%;' },
      { path: 'src/pages/home.tsx', kind: 'modified', truncated: false, diff: '-<h1>My portfolio</h1>\n+<h1>A little of what I make.</h1>' },
    ],
  }
}

export function entryOptions(lang: Lang): EntryOptionsT {
  return {
    status: 'ready', defaultProviderId: 'claude',
    providers: ['claude', 'codex', 'cursor'].map(id => ({
      id, displayName: id[0]!.toUpperCase() + id.slice(1), available: true,
      capabilities: {
        version: 1 as const, permissions: 'task' as const, configuration: 'task-policy' as const,
        completion: 'native' as const, stop: 'confirmed' as const, background: 'tracked' as const,
        features: { nativeResume: true, attachments: true, executionSettings: false, modelCatalog: false },
      },
    })),
    projects: [{ id: 'portfolio', name: t(lang, 'projPortfolio'), path: '~/Projects/portfolio', providerId: 'claude' }],
  }
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 演示的「CC 的连接」:微信历史就绪(最新到昨天)、知识库落后(4 天前)、wxsearch 就绪、wxmedia 没加载;形状与 daemon buildConnections 一致(插件按名排序)。 */
export function demoConnections(lang: Lang, now: number): ConnectionsT {
  return {
    generatedAt: now,
    sources: [
      { id: 'wechat_history', kind: 'wechat_history', name: 'wxvault', state: 'ready', latestAt: now - DAY, syncedAt: now - 2 * HOUR },
      { id: 'knowledge', kind: 'knowledge', name: 'knowledge', state: 'behind', latestAt: now - 4 * DAY, syncedAt: now - 4 * DAY },
      { id: 'plugin:wxmedia', kind: 'plugin', name: 'wxmedia', state: 'not_loaded', latestAt: null, syncedAt: null },
      { id: 'plugin:wxsearch', kind: 'plugin', name: 'wxsearch', state: 'ready', latestAt: null, syncedAt: null },
    ],
    computers: [{ id: 'home', label: 'Mac', online: true, since: now - 3 * DAY, version: null }],
    recent: [
      { matterId: IDS.portfolio, title: t(lang, 'portfolioTitle'), phase: 'working', at: now - 60_000 },
      { matterId: IDS.trip, title: t(lang, 'tripTitle'), phase: 'working', at: now - 30_000 },
    ],
    outputs: [],
  }
}

const SESSIONS: Array<{ key: string; provider: 'claude' | 'codex'; title: keyof typeof copy; project: string; ago: number; active: boolean }> = [
  { key: 'demo-claude-1', provider: 'claude', title: 'sessPortfolio', project: 'portfolio', ago: 20 * 60_000, active: true },
  { key: 'demo-claude-2', provider: 'claude', title: 'sessNotes', project: 'notes', ago: DAY, active: false },
  { key: 'demo-codex-1', provider: 'codex', title: 'sessTrip', project: 'trip-planner', ago: 2 * DAY, active: false },
]

/** 演示的电脑上原生会话(claude 2 条、codex 1 条);provider 省略 ⇒ 全部。 */
export function demoSessions(lang: Lang, now: number, provider?: 'claude' | 'codex'): NativeSessionRowT[] {
  return SESSIONS.filter(x => !provider || x.provider === provider)
    .map(x => ({ key: x.key, provider: x.provider, title: t(lang, x.title), project: x.project, updatedAt: now - x.ago, active: x.active }))
}

/** 每个演示会话一页三句(user / assistant / user)。 */
export function demoSessionMessages(lang: Lang): NativeSessionPageT['messages'] {
  return [
    { id: 'm1', role: 'user', text: t(lang, 'sessQ1'), truncated: false },
    { id: 'm2', role: 'assistant', text: t(lang, 'sessA1'), truncated: false },
    { id: 'm3', role: 'user', text: t(lang, 'sessQ2'), truncated: false },
  ]
}
