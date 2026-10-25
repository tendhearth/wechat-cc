/**
 * 「CC 做过的事」(重构第二批步 6c,从 main.ts 搬出来):手机时间线、微信「做过的事」、周报共用的一组来源,
 * 加上没留记录的动作(主动说话 / 定时 / 提醒)补记的那份 activity log。只算主人。
 */
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../../lib/log'
import { loadAccess } from '../../lib/access'
import type { Db } from '../../lib/db'
import { ACTIVITY_WINDOW_MS, buildActivity } from '../../domain/cc-activity'
import { makeFileStateStore as makeCliUpgradeStateStore } from '../../core/cli-upgrade/state'
import type { makeJobsStore } from '../../core/scheduled-jobs-store'
import type { makeCliEventHub } from '../../core/cli-events'
import { resolveAdminChatId } from './index'
import { loadCompanionConfig } from '../../lib/companion-config'
import { makeActivityLog } from '../activity-log'
import { makeActivityCommand } from '../activity/command'
import { collectActivity } from '../cc-activity-source'
import { listLetters } from '../../features/letters'
import { MEMORY_LOG_FILE, ownerMemoryRoot } from '../../features/memory'
import type { makePermissionDecisionsStore } from '../permission-decisions-store'
import type { IlinkAdapter } from '../ilink-glue'

export interface WireActivityDeps {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  permissionDecisions: ReturnType<typeof makePermissionDecisionsStore>
  cliEvents: ReturnType<typeof makeCliEventHub>
  jobsStore: ReturnType<typeof makeJobsStore>
}

export function wireActivity(d: WireActivityDeps) {
  const { stateDir, db, ilink, permissionDecisions, cliEvents, jobsStore } = d
  // 「CC 做过的事」(B9,spec 2026-10-20-cc-activity-design):没留记录的动作(主动说话 / 定时 / 提醒)补记一行,
  // 只记状态 + id;手机时间线把它和已有记录(规则批 / 一起做 / 终端 / 信 / 记忆 / CLI 升级)合起来。只算主人。
  const activityLog = makeActivityLog({ stateDir, now: () => Date.now(), log: (t, l) => log(t, l) })
  const activityOwner = () => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
  const activity = {
    now: () => Date.now(),
    sources: () => {
      const since = Date.now() - ACTIVITY_WINDOW_MS
      return collectActivity({
        now: () => Date.now(), ownerChatId: activityOwner,
        decisions: () => permissionDecisions.since(since, 200),
        tasks: () => db.query<{ id: string; title: string; status: string; updatedAt: number; ownerChatId: string | null }, [number]>('SELECT id,title,status,updated_at AS updatedAt,owner_chat_id AS ownerChatId FROM workbench_tasks WHERE updated_at>=? ORDER BY updated_at DESC LIMIT 200').all(since),
        terminal: () => cliEvents.list({ includeEnded: true, limit: 200 }).filter(v => v.last_event_at >= since),
        letters: () => listLetters(stateDir),
        memoryLog: () => {
          const o = activityOwner(), root = o ? ownerMemoryRoot(stateDir, o) : null
          const f = root ? join(root, MEMORY_LOG_FILE) : null
          if (!f || !fsExistsSync(f)) return []
          return fsReadFileSync(f, 'utf8').split('\n').slice(-200).flatMap((l: string) => { try { const r = JSON.parse(l); return r && typeof r.at === 'string' ? [r] : [] } catch { return [] } })
        },
        log: () => activityLog.read(since),
        jobs: () => jobsStore.list().jobs,
        reminderText: (id) => {
          const o = activityOwner()
          return o ? db.query<{ text: string }, [string, string]>('SELECT text FROM reminders WHERE id=? AND chat_id=?').get(id, o)?.text ?? null : null
        },
        cliUpgrades: () => Object.entries(makeCliUpgradeStateStore(stateDir).load()).map(([cli, s]) => ({ cli, last: s.lastUpgrade ?? null })),
      })
    },
  }
  // 微信「做过的事 [今天|本周]」(B9 在微信上):与手机时间线同一组来源,只认主人。
  const activityCommand = makeActivityCommand({
    isOwner: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
    say: (c, t) => ilink.sendMessage(c, t),
    now: () => Date.now(), timeZone: () => loadCompanionConfig(stateDir).timezone ?? 'Asia/Shanghai',
    items: () => { const r = buildActivity(activity.sources(), { now: Date.now(), limit: 100 }); return { items: r.items, degraded: r.degraded } },
  })

  return { activityLog, activity, command: activityCommand }
}
