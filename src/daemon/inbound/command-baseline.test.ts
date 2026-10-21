/**
 * 重构第二批 · 步 1(spec 2026-10-20-refactor-batch2-design §1.4 / §5):微信命令的基线快照。**只加测试,不改行为。**
 *
 * 现在 77 条命令散在 9 套分发里,谁先认靠 INTENT_ORDER 和链上的位置。这里把每套的「认不认」单独拿出来,
 * 喂一份语料(每类命令的例子 + 真机常见的普通聊天),记下每句话被哪几套认领 —— 一句被两套以上认领就是冲突。
 * 快照就是 CommandRegistry 的基线:搬完以后同一份语料重跑,除了 §1.5 列出的 bug 修复,结果要逐条一致。
 *
 * 状态相关的几套只按「状态成立时」记(导入记忆第一步、待批准的权限);入群欢迎(onboarding)与陌生人邀请码(mw-access)不在这里。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWechatTaskCommand } from '../../core/workbench/wechat-control'
import { isAdminCommandText } from '../admin-commands'
import { makeModeCommands } from '../mode-commands'
import { parsePermissionReply } from '../pending-permissions'
import { parseJobCommand, parseBriefPref } from '../../core/scheduled-jobs'
import { parseCalendarCommand } from '../calendar/calendar'
import { parseActivityCommand } from '../activity/command'
import { makeProjectLessonsCommand } from '../project-lessons-command'
import { makeProjectLessons } from '../../core/workbench/project-lessons'
import { makeMemoryImportCommand } from '../memory/import-command'
import { parseCliReply } from '../../core/cli-reply'
import { parseVisitCommand } from '../../core/visit-command'
import { parseLetterCommand } from '../../core/penpal-letter-command'
import { parsePairCommand } from '../../core/pair-command'
import { parseSeekCommand } from '../../core/seek-command'
import { parseIntroCommand } from '../../core/intro-command'
import { parseGuestCommand } from '../../core/guest-command'

const owner = 'owner'
const mode = makeModeCommands({} as never)   // probe 只看正则,不碰 deps
const lessons = makeProjectLessonsCommand({ isOwner: () => true, say: async () => {}, projects: () => [], lessons: makeProjectLessons(mkdtempSync(join(tmpdir(), 'cb-'))) })
const memoryImport = makeMemoryImportCommand({ isOwner: () => true, say: async () => {}, now: () => 0, importEntries: async () => ({ added: 0, skipped: { duplicate: 0, corrected: 0, cap: 0, invalid: 0 } }) as never })

/** 每套分发「认不认」,按现在的 INTENT_ORDER 排(command-router 跑在派发之后,排最后)。 */
const MATCHERS: Array<[string, (text: string) => boolean]> = [
  ['task-command', t => isWechatTaskCommand(t)],
  ['admin', t => isAdminCommandText(t.trim(), ['小黑'])],
  ['mode', t => mode.probe({ text: t } as never)],
  ['permission-reply(有待批准时)', t => parsePermissionReply(t) !== null],
  ['cli-reply:jobs', t => parseJobCommand(t) !== null || parseBriefPref(t) !== null],
  ['cli-reply:calendar', t => parseCalendarCommand(t) !== null],
  ['cli-reply:activity', t => parseActivityCommand(t) !== null],
  ['cli-reply:lessons', t => lessons.probe(t, owner)],
  ['cli-reply:memory-import(起头)', t => memoryImport.probe(t, owner)],
  ['cli-reply:cli', t => parseCliReply(t) !== null],
  ['router:visit', t => parseVisitCommand(t) !== null],
  ['router:letter', t => parseLetterCommand(t) !== null],
  ['router:pair', t => parsePairCommand(t) !== null],
  ['router:seek', t => parseSeekCommand(t) !== null],
  ['router:intro', t => parseIntroCommand(t) !== null],
  ['router:guest', t => parseGuestCommand(t) !== null],
]

/** 每类命令的例子(来自清点,§1.3 / §1.5)。 */
const COMMAND_EXAMPLES = [
  '任务', '任务 列表', '/task', '任务 项目', '任务 abcd1234', '任务 abcd1234 停止', '任务 abcd1234 补充 再加一个测试', '任务 abcd1234 请 @codex 审', '任务 对比 abcd1234 ef567890',
  '/health', '/reset', '/update', '自改 状态', '自改 把早报改短一点', '看记忆', '整理记忆', '背包', '有哪些手', '派小黑跑 测试', '/botname 小C', '/hearth list',
  '/cc', '/codex', '/cc + codex', '/api list', '/set', '/set 免打扰 23:00-8:00', '/set quiet 关', '/both', '/chat', '/solo', '/stop', '/whoami', '/name 小明', '/help', '/帮助', '/foo',
  'y', 'n 07', '允许', '拒绝 ab12c', '同意 07',
  '定时', '定时 每天 9:00 看看邮箱', '定时 早报 8:00', '定时 周报 周日 20:00', '定时 停 j1', '早报', '早报 少点 天气',
  '日历', '日历 明天', '日历 开', '做过的事', '做过的事 本周', '经验', '经验 wechat-cc 用 bun', '导入记忆', '导入记忆 ChatGPT',
  '终端', '会话列表', '/cli', '日报', '/today', '看 ab12', '@ab12 继续',
  '串门', '串门 老王', '/visit', '回信 ch1 你好', '配对', '配对 123456', '派 w-ab12', '取消 w-ab12', '认识 ab12', '不了 ab12', '允许 123456', '邀请码', '待批准',
]

/** 真机常见的普通聊天(不该被任何命令认领;认领了就是 §1.5 的那类 bug)。 */
const CHAT = [
  '你好', '今天好累', '帮我看看这个报错', '@codex 帮我看看这个函数', '@claude 你觉得呢', '看 README 里怎么写的', '看看你',
  '早报那个能不能早点发', '经验告诉我别这么干', '日历上明天有啥', '1', '全部', '算了', '好', '不用了', '同意你的看法', '允许我说一句',
  '定时提醒我喝水', '任务太多了', '配对成功了吗', '串门好玩吗', '/', '/ 你好',
]

function claims(text: string): string[] { return MATCHERS.filter(([, m]) => { try { return m(text) } catch { return false } }).map(([n]) => n) }

describe('微信命令基线(重构第二批步 1;只加测试)', () => {
  it('command examples: who claims each one today', () => {
    expect(Object.fromEntries(COMMAND_EXAMPLES.map(t => [t, claims(t)]))).toMatchSnapshot()
  })
  it('ordinary chat: who (wrongly) claims it today', () => {
    expect(Object.fromEntries(CHAT.map(t => [t, claims(t)]))).toMatchSnapshot()
  })
  it('conflicts today (two or more claim the same text) — the list CommandRegistry must resolve', () => {
    const all = [...COMMAND_EXAMPLES, ...CHAT]
    expect(Object.fromEntries(all.map(t => [t, claims(t)]).filter(([, c]) => (c as string[]).length > 1))).toMatchSnapshot()
  })
})
