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
import { COMMAND_EXAMPLES, CHAT } from './command-corpus'
import { isWechatTaskCommand } from '../../features/workbench/wechat-control'
import { isAdminCommandText } from '../admin-commands'
import { makeModeCommands } from '../mode-commands'
import { parsePermissionReply } from '../pending-permissions'
import { parseJobCommand, parseBriefPref } from '../../domain/scheduled-jobs'
import { parseCalendarCommand } from '../../features/calendar/calendar'
import { parseActivityCommand } from '../activity/command'
import { makeProjectLessonsCommand } from '../project-lessons-command'
import { makeProjectLessons } from '../../features/workbench/project-lessons'
import { makeMemoryImportCommand } from '../../features/memory/import-command'
import { parseCliReply } from '../../core/cli-reply'
import { parseVisitCommand } from '../../features/social/visit-command'
import { parseLetterCommand } from '../../features/social/penpal-letter-command'
import { parsePairCommand } from '../../core/pair-command'
import { parseSeekCommand } from '../../features/social/seek-command'
import { parseIntroCommand } from '../../features/social/intro-command'
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
