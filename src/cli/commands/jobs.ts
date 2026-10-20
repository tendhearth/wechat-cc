// 定时任务(spec 2026-10-20-scheduled-jobs-design):直接改状态目录的 scheduled-jobs.json,不经 daemon。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { makeJobsStore } from '../../core/scheduled-jobs-store'
import { cliAddJob, cliFormatJobs, ownerTimezone } from '../jobs'
import { describeSchedule } from '../../core/scheduled-jobs'

const fail = (error: string): never => { console.error(error); process.exit(1) }
const idArg = { id: { type: 'positional' as const, required: true, description: 'Job id (see jobs list), e.g. j1' } }

const toggle = (name: 'pause' | 'resume' | 'rm') => defineCommand({
  meta: { name, description: name === 'rm' ? 'Delete a job' : name === 'pause' ? 'Pause a job' : 'Resume a paused job' },
  args: idArg,
  run({ args }) {
    const store = makeJobsStore(STATE_DIR)
    const id = String(args.id).toLowerCase()
    const ok = name === 'rm' ? store.remove(id) : store.setPaused(id, name === 'pause')
    if (!ok) fail(`没有定时 ${id}(或定时文件读不了)`)
    else console.log(name === 'rm' ? `已删 ${id}` : name === 'pause' ? `${id} 已暂停` : `${id} 已恢复`)
  },
})

export const jobsCmd = defineCommand({
  meta: { name: 'jobs', description: 'Owner-written scheduled jobs (read-only turns; same as WeChat「定时」)' },
  subCommands: {
    list: defineCommand({ meta: { name: 'list', description: 'List scheduled jobs' }, run() { console.log(cliFormatJobs(STATE_DIR, ownerTimezone(STATE_DIR))) } }),
    add: defineCommand({
      meta: { name: 'add', description: 'Add a scheduled job' },
      args: {
        every: { type: 'string', required: true, description: 'daily | weekdays | mon … sun' },
        at: { type: 'string', required: true, description: 'HH:MM in the owner timezone (companion config; shown in the reply)' },
        text: { type: 'string', required: true, description: 'What CC should look into' },
      },
      run({ args }) {
        const r = cliAddJob(STATE_DIR, { every: String(args.every), at: String(args.at), text: String(args.text) }, new Date())
        if (!r.ok) return fail(r.error)
        console.log(`已加 ${r.job.id}:${describeSchedule(r.job.schedule, ownerTimezone(STATE_DIR))}`)
      },
    }),
    rm: toggle('rm'),
    pause: toggle('pause'),
    resume: toggle('resume'),
  },
})
