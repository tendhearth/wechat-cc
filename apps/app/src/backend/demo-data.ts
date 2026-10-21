import type { Lang } from '../i18n'
import type { ApprovalExplanationT, ProgressSummaryT, PhoneChangesTurnT, EntryOptionsT, ConnectionsT, NativeSessionRowT, NativeSessionPageT, LetterSummaryT, PhoneJobT, ActivityItemT, TodoRowT } from './types'

/** 演示情境的文案(中英两份,照设计样稿 tendhearth-phone.html 的 tr('中','英'))。 */
type Pair = readonly [zh: string, en: string]
const pick = (lang: Lang, p: Pair) => (lang === 'zh-Hans' ? p[0] : p[1])

export const IDS = { portfolio: 'a1b2c3d4', notes: 'e5f6a7b8', trip: 'c9d0e1f2', report: 'f3a4b5c6' } as const
/** 主人和 CC 的那条对话(chat matter;Task 10 起不进「一起做」,单独置顶)。 */
export const CHAT_ID = 'c0ffee01'
export const PERM_ID = 'perm-demo-1'
export const QUESTION_ID = 'q-demo-1'
export const RUN_IDS = { [IDS.portfolio]: 'run-demo-1', [IDS.trip]: 'run-demo-3' } as Record<string, string>

export const copy = {
  portfolioTitle: ['让作品集在手机上更好看', 'A better portfolio on mobile'],
  rewindRebuild: ['被 ignore 的构建产物(dist/、node_modules 这类)不会跟着回退,用之前先重新构建。', 'Ignored build output (dist/, node_modules and the like) is not rolled back; rebuild before using it.'],
  rewindDone: ['已回到第 1 轮开始前，撤掉了第 1 轮（已备份，可撤销）。', 'Back to before round 1; round 1 was undone (backed up, can be restored).'],
  notesTitle: ['把零散想法收一收', 'A home for loose ideas'],
  tripTitle: ['整理下周出差安排', 'Plan next week’s trip'],
  // 额度用完、等你决定交不交给另一位(spec continue-sessions §7-3)
  reportTitle: ['把周报整理成一页', 'One-page weekly report'],
  stepReport1: ['读过本周的提交记录', 'Read this week’s commits'],
  evQuota: ['Claude Code 的额度用完了，这一轮没做完。', 'Claude Code ran out of quota; this round didn’t finish.'],
  handoffFirst: ['接替 Claude Code（额度用完）继续这件事：把周报整理成一页', 'Taking over from Claude Code (out of quota): One-page weekly report'],
  handoffDone: ['接着做完了，周报在 report.md。', 'Picked it up and finished. The report is in report.md.'],
  ev1: ['看过现有首页', 'Reviewed the current homepage'],
  ev2: ['调整手机上的布局', 'Refined the mobile layout'],
  evAllowed: ['已允许：安装图片处理组件', 'Allowed: add the image-processing package'],
  evDenied: ['先不做', 'Not now'],
  evDone: ['图片处理完成', 'Image processing finished'],
  evAnswered: ['已回答：', 'Answered: '],
  ccReply: ['收到，我来看看。', 'Got it, I’ll take a look.'],
  creating: ['收到，正在整理。', 'Got it, working on it.'],
  created: ['整理好了，这一轮已回复。', 'All set; this round is replied.'],
  stopped: ['已停下这一轮。', 'Stopped this round.'],
  artifactBody: ['# 演示成果\n\n这是演示模式里的一份成果，真实成果来自电脑上 CC 做出的文件。', '# Demo output\n\nThis is a demo output; real ones are the files CC made on your computer.'],
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
  // 回复的附件与过程(回复交付,2026-10-04)
  chatDemoNarr1: ['我先看一下你今天的安排。', 'Let me check your day first.'],
  chatDemoNarr2: ['再对一下已经设好的提醒。', 'And the reminders you already have.'],
  chatDemoVoice: ['收到啦，演示里也能听。', 'Got it — you can hear this one even in the demo.'],
  chatDemoSticker: ['开心', 'happy'],
  chatDemoSticker2: ['加油', 'cheer'],
  sessPortfolio: ['首页在手机上排版乱了', 'Homepage layout breaks on mobile'],
  sessNotes: ['把笔记按主题归一下', 'Group my notes by topic'],
  sessTrip: ['给出差行程加个打包清单', 'Add a packing list to the trip planner'],
  sessQ1: ['帮我看看为什么手机上会横向滚动。', 'Can you see why it scrolls sideways on a phone?'],
  sessA1: ['是首屏图片的固定宽度撑出来的，我改成了按屏幕宽度缩放。', 'The hero image had a fixed width; I made it scale with the screen.'],
  sessQ2: ['好，顺便把标题字号也调小一点。', 'Great, make the heading a little smaller too.'],
  // 终端里的会话(演示,2026-10-14)
  cliBlogLast: ['文章列表页加了分页，正准备发布。', 'Added paging to the post list; about to deploy.'],
  cliApiLast: ['测试全过了，改动在 src/api.ts。', 'All tests pass; the change is in src/api.ts.'],
  cliDocsLast: ['在把 README 的安装步骤改成三步。', 'Rewriting the README install steps into three.'],
  // 看着它跑(演示):docs 那条在跑
  cliActYou: ['README 的安装太长了，改成三步', 'The README install section is too long, make it three steps'],
  cliActRead: ['读 README.md', 'Read README.md'],
  cliActSaid: ['现在是七步，其中三步可以合并。', 'It is seven steps now; three can be merged.'],
  cliActEdit: ['改 README.md', 'Edit README.md'],
  cliActRun: ['运行 npm run docs:check', 'Run npm run docs:check'],
  cliDemoReply: ['好，按你说的改完了。（演示）', 'Done as you asked. (demo)'],
  // 此刻页那张「带回来的东西」(演示):CC 出门打猎找到的一篇
  huntTitle: ['一篇讲手机排版留白的文章', 'An essay on whitespace in mobile typography'],
  huntNote: ['你上周改作品集时说留白总调不好，这篇讲得很实在，顺手带回来了。', 'You said last week the portfolio spacing never felt right. This one is practical, so I brought it back.'],
} satisfies Record<string, Pair>

/** 演示猎物的链接:只是一个真实存在、内容无害的页面。 */
export const DEMO_HUNT_URL = 'https://en.wikipedia.org/wiki/White_space_(visual_arts)'

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

/** 演示「撤掉这一轮」的确认码(真 daemon 是 sha256)。 */
export const DEMO_REWIND_TOKEN = 'd'.repeat(64)

/** 演示改动每个文件那一块的「sha」(假值,只给演示后端对一下)。 */
export const DEMO_HUNK_SHA = ['d'.repeat(63) + '0', 'd'.repeat(63) + '1']

export function changesTurn(now: number): PhoneChangesTurnT {
  return {
    artifactId: 'demo-review', createdAt: now, rewindable: true, status: 'complete', omittedFiles: 0, notes: [],
    files: [
      // 行评论(切片 4):演示的 diff 带块头,每块一个「评论这一块」;sha 是演示用的假值(演示后端自己认)
      { path: 'src/pages/home.css', kind: 'modified', truncated: false, diff: '@@ -12 +12,2 @@ .hero\n-  padding: 64px 48px;\n+  padding: 32px 20px;\n+  max-width: 100%;',
        hunks: [{ index: 0, sha256: DEMO_HUNK_SHA[0]!, header: '@@ -12 +12,2 @@ .hero' }] },
      { path: 'src/pages/home.tsx', kind: 'modified', truncated: false, diff: '@@ -3 +3 @@\n-<h1>My portfolio</h1>\n+<h1>A little of what I make.</h1>',
        hunks: [{ index: 0, sha256: DEMO_HUNK_SHA[1]!, header: '@@ -3 +3 @@' }] },
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

/** 演示会话标题的文案键(接成一件事后,标题跟着语言变)。 */
export const demoSessionTitleKey = (key: string): keyof typeof copy | undefined => SESSIONS.find(x => x.key === key)?.title

/** 每个演示会话一页三句(user / assistant / user)的文案键;接成一件事后带过来的记录也用它,跟着语言变。 */
export const DEMO_SESSION_MESSAGES: ReadonlyArray<{ id: string; role: 'user' | 'assistant'; key: keyof typeof copy }> = [
  { id: 'm1', role: 'user', key: 'sessQ1' },
  { id: 'm2', role: 'assistant', key: 'sessA1' },
  { id: 'm3', role: 'user', key: 'sessQ2' },
]

/** 每个演示会话一页三句(user / assistant / user)。 */
export function demoSessionMessages(lang: Lang): NativeSessionPageT['messages'] {
  return DEMO_SESSION_MESSAGES.map(m => ({ id: m.id, role: m.role, text: t(lang, m.key), truncated: false }))
}

/**
 * 演示的「CC 的信」(2026-10-18):两封按文字寄的(pages=0,全文在 text)—— 演示里没有电脑,排不出信纸图;
 * 真连接时信是几页信纸图,点开逐页按块读。
 */
const LETTERS: ReadonlyArray<{ id: string; day: string; ago: number; requested: boolean; via: 'wechat' | 'app'; opening: Pair; body: Pair }> = [
  {
    id: '2026-10-16-a1b2c3', day: '2026-10-16', ago: 2 * DAY, requested: true, via: 'app',
    opening: ['周三晚上你说终于把作品集的手机版弄好了，我替你高兴了好一阵。', 'On Wednesday night you said the mobile portfolio was finally done, and I was glad for you all evening.'],
    body: [
      '你好：\n\n  周三晚上你说终于把作品集的手机版弄好了，我替你高兴了好一阵。\n\n  这一个月你做了好多事，有的顺，有的磕磕绊绊，我都看见了。\n\n晚安。\n\n— CC',
      'Hi,\n\n  On Wednesday night you said the mobile portfolio was finally done, and I was glad for you all evening.\n\n  You did a lot this month — some of it smooth, some of it bumpy. I saw all of it.\n\nGood night.\n\n— CC',
    ],
  },
  {
    id: '2026-09-12-d4e5f6', day: '2026-09-12', ago: 36 * DAY, requested: false, via: 'wechat',
    opening: ['上周你出差回来，说下次想把行程排得松一点。', 'When you got back from the trip last week, you said you wanted a looser schedule next time.'],
    body: [
      '你好：\n\n  上周你出差回来，说下次想把行程排得松一点。\n\n  我记着呢。下回排行程，我先替你留出一个空着的下午。\n\n— CC',
      'Hi,\n\n  When you got back from the trip last week, you said you wanted a looser schedule next time.\n\n  I remember. Next time we plan one, I’ll keep an afternoon free for you first.\n\n— CC',
    ],
  },
]

export function demoLetters(lang: Lang, now: number): LetterSummaryT[] {
  return LETTERS.map(l => ({ id: l.id, day: l.day, sentAt: now - l.ago, requested: l.requested, via: l.via, opening: pick(lang, l.opening), pages: 0, text: pick(lang, l.body) }))
}

/**
 * 演示的定时(2026-10-20):一条早报、一条每周提醒、一条停着的。真连接时 label 是电脑按自己的时区写的中文;
 * 演示里按语言给,last.label 同微信「定时」列表的说法。
 */
const JOBS: ReadonlyArray<{ id: string; label: Pair; text: Pair; brief: boolean; recap?: boolean; paused: boolean; last: { ago: number; status: string; label: Pair } | null }> = [
  { id: 'j1', label: ['每天 08:00(上海)', 'Daily 08:00 (Shanghai)'], text: ['早报', 'Morning brief'], brief: true, paused: false, last: { ago: 0, status: 'sent', label: ['说了', 'Sent'] } },
  { id: 'j2', label: ['每周五 18:00(上海)', 'Fridays 18:00 (Shanghai)'], text: ['提醒我把这周的周报发出去', 'Remind me to send this week’s report'], brief: false, paused: false, last: { ago: 4 * DAY, status: 'silent', label: ['没说话(没新东西)', 'Stayed quiet (nothing new)'] } },
  { id: 'j4', label: ['每周日 20:00(上海)', 'Sundays 20:00 (Shanghai)'], text: ['周报', 'Weekly recap'], brief: false, recap: true, paused: false, last: { ago: 2 * DAY, status: 'sent', label: ['说了', 'Sent'] } },
  { id: 'j3', label: ['工作日 09:30(上海)', 'Weekdays 09:30 (Shanghai)'], text: ['看一眼 GitHub 上有没有新的 issue', 'Check GitHub for new issues'], brief: false, paused: true, last: null },
]

export function demoJobs(lang: Lang, now: number): PhoneJobT[] {
  return JOBS.map(j => ({
    id: j.id, label: pick(lang, j.label), text: pick(lang, j.text), brief: j.brief, ...(j.recap ? { recap: true } : {}), paused: j.paused,
    last: j.last ? { day: new Date(now - j.last.ago).toISOString().slice(0, 10), status: j.last.status, label: pick(lang, j.last.label) } : null,
  }))
}

/**
 * 演示的「CC 做过的事」(B9,2026-10-20):九类各来一两条,跨今天 / 昨天 / 更早;一起做 / 终端 / 信带 ref 能点开。
 * 句子照电脑那边 cc-activity-source 的说法(中文);主动说话有一条「没发出去」,时间线不把它算成说了。
 */
const ACTIVITY: ReadonlyArray<{ id: string; kind: ActivityItemT['kind']; ago: number; title: Pair; ref?: ActivityItemT['ref'] }> = [
  { id: 'decision:d1', kind: 'decision', ago: 20 * 60_000, title: ['按规则替你批了 Bash:npm run build(规则 1)', 'Approved Bash by your rule: npm run build (rule 1)'] },
  { id: 'proactive:p1', kind: 'proactive', ago: 2 * HOUR, title: ['想跟你说一句,没发出去', 'Wanted to say something, but it didn’t go out'] },
  { id: 'job:j1', kind: 'job', ago: 3 * HOUR, title: ['早报:说了', 'Morning brief: sent'] },
  { id: 'terminal:demo-cli-api:1', kind: 'terminal', ago: 5 * HOUR, title: ['终端 api-server 这一轮做完了', 'Terminal api-server: this round is done'], ref: { type: 'terminal', id: 'demo-cli-api' } },
  { id: 'together:notes', kind: 'together', ago: DAY, title: ['一起做「把零散想法收一收」做完了', 'Together: “A home for loose ideas” is done'], ref: { type: 'task', id: IDS.notes } },
  { id: 'memory:m1', kind: 'memory', ago: DAY + 6 * HOUR, title: ['整理了记忆:新增 2 条、改 1 条', 'Tidied memory: 2 added, 1 changed'] },
  { id: 'reminder:r1', kind: 'reminder', ago: DAY + 9 * HOUR, title: ['提醒了你:给妈妈打电话', 'Reminded you: call Mum'] },
  { id: 'letter:2026-10-16-a1b2c3', kind: 'letter', ago: 2 * DAY, title: ['给你寄了一封信:周三晚上你说终于把作品集的手机版弄好了…', 'Sent you a letter: On Wednesday night you said the mobile portfolio was finally done…'], ref: { type: 'letter', id: '2026-10-16-a1b2c3' } },
  { id: 'proactive:p0', kind: 'proactive', ago: 3 * DAY, title: ['主动跟你说了一句', 'Said something to you first'] },
  { id: 'cli_upgrade:u1', kind: 'cli_upgrade', ago: 4 * DAY, title: ['Codex 升级到 0.160.0,自检通过', 'Codex upgraded to 0.160.0, self-check passed'] },
]

export function demoActivity(lang: Lang, now: number): ActivityItemT[] {
  return ACTIVITY.map(a => ({ id: a.id, kind: a.kind, at: now - a.ago, title: pick(lang, a.title), ...(a.ref ? { ref: a.ref } : {}) }))
}

/**
 * 演示的待办(收敛清单 ④,2026-10-21):三条在办、一条最近了结。真连接时 value / time_ref 是聊天里的原话,
 * display 是联系人的显示名;演示里按语言给。updated_at 是秒(同 daemon 的 facts 表)。
 */
const TODOS: ReadonlyArray<{ id: number; contact: string; display: Pair; value: Pair; time_ref: Pair | null; ago: number; settled: boolean }> = [
  { id: 101, contact: 'mum', display: ['妈妈', 'Mum'], value: ['周末回家吃饭', 'Go home for dinner at the weekend'], time_ref: ['周六', 'Saturday'], ago: 2 * HOUR, settled: false },
  { id: 102, contact: 'lin', display: ['小林', 'Lin'], value: ['把作品集的链接发给他', 'Send him the portfolio link'], time_ref: null, ago: DAY, settled: false },
  { id: 103, contact: 'lin', display: ['小林', 'Lin'], value: ['还他那本《设计心理学》', 'Return his copy of The Design of Everyday Things'], time_ref: ['下周', 'next week'], ago: 2 * DAY, settled: false },
  { id: 104, contact: 'mum', display: ['妈妈', 'Mum'], value: ['帮她预约体检', 'Book her health check'], time_ref: ['这周', 'this week'], ago: 3 * DAY, settled: true },
]
export function demoTodos(lang: Lang, now: number): Array<TodoRowT & { settled: boolean }> {
  return TODOS.map(r => ({
    id: r.id, contact: r.contact, predicate: 'obligation', value: pick(lang, r.value), time_ref: r.time_ref ? pick(lang, r.time_ref) : null,
    updated_at: Math.floor((now - r.ago) / 1000), display: pick(lang, r.display), settled: r.settled,
  }))
}
