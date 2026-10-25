/**
 * 微信「定时」(spec 2026-10-20-scheduled-jobs-design):只认主人那条对话;不是主人 ⇒ 不当命令,落回普通聊天。
 */
import { BRIEF_PREF_USAGE, describeSchedule, JOB_USAGE, nextRunLabel, parseBriefPref, parseJobCommand, type ScheduledJob } from '../../core/scheduled-jobs'
import { localParts } from '../../daemon/memory/nightly-schedule'
import type { JobsStore } from '../../core/scheduled-jobs-store'
import { hhmmInQuiet, quietLabel, type QuietWindow } from '../../core/quiet-hours'
import { providerDisplayName } from '../../core/provider-display-names'

import type { ReplyHandler } from '../../daemon/commands/registry'
export type { ReplyHandler }


const STATUS_WORDS: Record<string, string> = { sent: '说了', silent: '没说话(没新东西)' }
/** 上次结果的人话(微信列表与手机列表共用)。 */
export function statusWord(s: string | null): string {
  if (!s) return '还没跑过'
  if (STATUS_WORDS[s]) return STATUS_WORDS[s]!
  if (s.startsWith('skipped:')) return { 'skipped:network': '跳过(网络不安全)', 'skipped:cap': '跳过(当天定时满了)', 'skipped:executor': '跳过(当前执行者不支持)', 'skipped:degraded': '跳过(发不出去)', 'skipped:quiet': '跳过(在免打扰里)', 'skipped:care_off': '跳过(你说了别烦我)' }[s] ?? '跳过'
  return `没跑成(${s.replace(/^failed:/, '')})`
}

export function makeJobsCommand(deps: {
  store: JobsStore
  isOwner: (chatId: string) => boolean
  say: (chatId: string, text: string) => Promise<unknown>
  timezone: () => string
  now: () => number
  log: (tag: string, line: string) => void
  /** 定时那一轮会用哪个执行者(tick-bodies 的 pickJobExecutor);null ⇒ 这台跑不了。缺省 ⇒ 不提。 */
  jobExecutor?: () => string | null
  /** 早报的口味(memory/<owner>/brief-prefs.md);缺省 ⇒ 「早报 …」不当命令。 */
  briefPrefs?: { read(): string[]; add(line: string): void; clear(): void }
  /** 主人设的免打扰(chat-prefs 主人那条)。早报 / 周报的时间落在里面 ⇒ 建的时候当场说「会天天跳过」(整合者评审 #509)。 */
  quietWindow?: () => QuietWindow | undefined
}): ReplyHandler {
  const quietNote = (j: ScheduledJob): string => {
    const w = deps.quietWindow?.()
    if (!(j.brief || j.recap) || !w || !hhmmInQuiet(j.schedule.at, w)) return ''
    return `\n注意:${j.schedule.at} 落在你的免打扰(${quietLabel(w)})里,${j.brief ? '早报' : '周报'}到点会跳过,不会晚点补。想让它照常来,换个时间,或者改免打扰。`
  }
  const execNote = (): string => {
    if (!deps.jobExecutor) return ''
    const e = deps.jobExecutor()
    return e ? `定时用 ${providerDisplayName(e)} 跑(只读)。` : '注意:这台电脑上没有 Claude 或 Codex,定时现在跑不了(只有这两家能保证只读)。装上或登录其中一个就会照常跑。'
  }
  const local = () => localParts(deps.now(), deps.timezone())
  const head = (t: string) => { const a = [...t]; return a.length <= 30 ? t : a.slice(0, 29).join('') + '…' }
  const line = (j: ScheduledJob) => {
    const st = deps.store.state(j.id)
    const last = st.lastRunAt ? `上次 ${st.lastRunDay?.slice(5)} ${statusWord(st.lastStatus)}` : '还没跑过'
    return `${j.id} · ${describeSchedule(j.schedule, deps.timezone())}${j.paused ? ' · 停着' : ''} · ${j.brief ? '早报' : j.recap ? '周报' : head(j.text)} · ${last}`
  }
  return {
    probe: (text, chatId) => (parseJobCommand(text) !== null || (!!deps.briefPrefs && parseBriefPref(text) !== null)) && deps.isOwner(chatId),
    async handle(text, chatId) {
      const pref = deps.briefPrefs ? parseBriefPref(text) : null
      if (pref && deps.briefPrefs) {
        if (!deps.isOwner(chatId)) return false
        const say = (t: string) => deps.say(chatId, t)
        if (pref.kind === 'usage') await say(BRIEF_PREF_USAGE)
        else if (pref.kind === 'show') { const l = deps.briefPrefs.read(); await say(l.length ? `早报的口味:\n${l.map(x => `· ${x}`).join('\n')}` : `早报还没有口味。\n\n${BRIEF_PREF_USAGE}`) }
        else if (pref.kind === 'clear') { deps.briefPrefs.clear(); await say('早报的口味清空了。') }
        else { deps.briefPrefs.add(pref.line); await say(`记下了,下一份早报${pref.line.replace(':', '')}。`) }
        return true
      }
      const cmd = parseJobCommand(text)
      if (!cmd || !deps.isOwner(chatId)) return false
      const reply = (t: string) => deps.say(chatId, t)
      if (cmd.kind === 'usage') { await reply(cmd.error); return true }
      if (cmd.kind === 'list') {
        const { jobs, error } = deps.store.list()
        if (error) { await reply(`定时文件读不了:${error}`); return true }
        const note = execNote()
        await reply(jobs.length ? `定时(${jobs.length} 个):\n${jobs.map(line).join('\n')}\n\n「定时 停 / 开 / 删 <编号>」${note && !note.startsWith('定时用') ? `\n${note}` : ''}` : `还没有定时。\n\n${JOB_USAGE}`)
        return true
      }
      if (cmd.kind === 'add') {
        if (cmd.brief) {
          const existing = deps.store.list().jobs.find(j => j.brief)
          if (existing) { await reply(`已经有一份早报了(${existing.id} · ${describeSchedule(existing.schedule, deps.timezone())})。要改时间就先「定时 删 ${existing.id}」再建。`); return true }
        }
        if (cmd.recap) {
          const existing = deps.store.list().jobs.find(j => j.recap)
          if (existing) { await reply(`已经有一份周报了(${existing.id} · ${describeSchedule(existing.schedule, deps.timezone())})。要改时间就先「定时 删 ${existing.id}」再建。`); return true }
        }
        const r = deps.store.add(cmd.schedule, cmd.text, new Date(deps.now()), cmd.brief ? { brief: true } : cmd.recap ? { recap: true } : {})
        if (!r.ok) { await reply(r.error); return true }
        deps.log('JOBS', `owner added ${r.job.id} ${describeSchedule(r.job.schedule)}`)
        await reply(`记下了(${r.job.id}):${describeSchedule(r.job.schedule, deps.timezone())} ${r.job.brief ? '早报 —— 今天到期的事、昨天各执行者做了什么、等你拍板的;没东西就不发。「早报 少点 / 多点 …」调口味' : r.job.recap ? '周报 —— CC 这一周替你做了什么、哪些卡住了、下周值得留意的;没东西就不发' : head(r.job.text)}\n下次:${nextRunLabel(r.job.schedule, local())}。到时候我只看、只查,有值得说的才找你,没新东西就不吭声。${execNote()}${quietNote(r.job)}`)
        return true
      }
      const exists = deps.store.list().jobs.some(j => j.id === cmd.id)
      if (!exists) { await reply(`没有定时 ${cmd.id}。发「定时」看列表。`); return true }
      const ok = cmd.kind === 'remove' ? deps.store.remove(cmd.id) : deps.store.setPaused(cmd.id, cmd.kind === 'pause')
      await reply(!ok ? '没改成(定时文件读不了),稍后再试。' : cmd.kind === 'remove' ? `删了 ${cmd.id}。` : cmd.kind === 'pause' ? `${cmd.id} 先停了。` : `${cmd.id} 开了。`)
      return true
    },
  }
}
