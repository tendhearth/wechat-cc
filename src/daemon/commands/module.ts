/**
 * 主人的命令接进 daemon 的那一份:命令现在就要(进命令表),要用的只读轮 / 工作台 / 门都在后面 ⇒ 经 late 现取。
 * 只有模块表 daemon-modules.ts 引这个文件。
 */
import { makeProjectLessons, type WorkbenchService } from '../../features/workbench'
import { makeMemoryImportCommand } from '../../features/memory'
import type { TerminalFeature } from '../../features/terminal'
import type { JobsFeature } from '../../features/jobs'
import type { CalendarFeature } from '../../features/calendar'
import { WECHAT_PORTS as W, type WechatSend } from '../../ports/wechat'
import type { DaemonModule } from '../modules/container'
import type { Foundation } from '../foundation'
import type { Bootstrap } from '../bootstrap'
import type { InternalApiLifecycle } from '../internal-api/lifecycle'
import type { WiredDeps } from '../wiring'
import type { Activity } from '../bootstrap/wire-activity'
import { makeProjectLessonsCommand } from '../project-lessons-command'
import { isOwnerOf } from '../owner-chat'
import { fromReplyHandler } from './registry'

/** 「主人的命令」那一组:定时 / 日历 / 做过的事 / 经验 / 导入记忆 / 终端会话(命令表里的顺序就是优先级)。 */
export interface OwnerCommands {
  commands: ReturnType<typeof fromReplyHandler>[]
}

export function ownerCommandsModule(f: Foundation): DaemonModule<OwnerCommands> {
  const { stateDir } = f
  const isOwner = isOwnerOf(stateDir)
  return {
    name: 'owner-commands',
    needs: ['bootstrap', 'terminal', 'calendar', 'activity', 'jobs', W.send, 'internal-api', 'network-gate'],
    lazy: ['workbench', 'wired'],
    init(ctx): OwnerCommands {
      const boot = ctx.get<Bootstrap>('bootstrap')
      const wxSend = ctx.get<WechatSend>(W.send)
      const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
      const cli = ctx.get<TerminalFeature>('terminal')
      const workbench = ctx.late<WorkbenchService>('workbench')
      const wired = ctx.late<WiredDeps>('wired')
      const say = (c: string, t: string) => wxSend.sendMessage(c, t)
      const activity = ctx.get<Activity>('activity')
      const jobs = ctx.get<JobsFeature>('jobs')
      // 微信「经验 <项目> …」(第二轮对标 ★2):只认主人;项目按名字认。
      const lessonsCommand = makeProjectLessonsCommand({
        isOwner, say,
        projects: () => { const w = workbench(); return w ? w.projects().map(p => ({ name: p.name, path: p.path })) : null },
        lessons: makeProjectLessons(stateDir),
      })
      // 微信「导入记忆」(第二轮对标 #7):主人把别的助手对他的了解贴回来,点头的才写进记忆。
      const memoryImportCommand = makeMemoryImportCommand({
        isOwner, say, now: () => Date.now(),
        importEntries: (items, label) => { const w = wired(); if (!w) throw new Error('memory_not_wired'); return w.memoryNightly.importEntries(items, label) },
      })
      // 读日历和提醒:一个功能一个目录(src/features/calendar);命令从那里来。
      const { command: calendarCommand } = ctx.get<CalendarFeature>('calendar')
      // 微信「终端」「看 码」「@码 …」「y 码」:终端会话那个功能造好的(src/features/terminal)
      const cliReplyHandler = cli.command
      return {
        // 命令表的顺序就是优先级(重构第二批步 2;与原来文本命令链的顺序一致)
        commands: [fromReplyHandler('jobs', jobs.command), fromReplyHandler('calendar', calendarCommand), fromReplyHandler('activity', activity.command), fromReplyHandler('lessons', lessonsCommand), fromReplyHandler('memory-import', memoryImportCommand), fromReplyHandler('cli', cliReplyHandler, { ownsSlash: (m) => /^\s*\/(?:cli|today)\s*[?？]?\s*$/i.test(m.text ?? '') })],
      }
    },
  } satisfies DaemonModule<OwnerCommands>
}
