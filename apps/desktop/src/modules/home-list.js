// @ts-check
// home-list.js — 主页的「在做」「带回来的」两组(设计稿 2026-10-31 §4 U4)。无 DOM。
// 此刻与一起做合成一个主页:一件事、终端会话都是同一种行,分组与状态词只认生成物 status-table.js
// (源头在 packages/protocol/src/status-table.ts,App 与手机网页用同一张)。「等你」那一组由 now-page.js 自己画
// (行上写请求本身、终端的可以就地拍板),这里不出等你的行,也不把等你的事误标成在做。
import { QUIET_AFTER_MS, ROW_HINT_WORDS, STATUS_TABLE, STATUS_WORDS } from '../generated/status-table.js'
import { formatRelativeTime } from '../view.js'
import { createAgentAvatars } from '../shared/agent-avatars.js'

const AGENTS = createAgentAvatars()
export const BACK_WINDOW_MS = 24 * 3_600_000
const count = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0

/** @typedef {import('../generated/status-table.js').StatusKey} StatusKey */
/** @typedef {{id:string,title:string,providerId:string,agents?:string[],status:string,phase?:string,runtime?:{retained?:boolean,foreground?:string,backgroundCount?:number},updatedAt:number,archivedAt?:number|null,importedOnly?:boolean,pendingPermissionCount?:number,pendingQuestionCount?:number}} HomeTask */
/** @typedef {{session_id:string,source?:string,displayName?:string,status:string,stale?:boolean,project?:string,last_summary?:string|null,last_event_at?:number,now?:{text?:string}|null}} HomeSession */
/** @typedef {{id:string,source:'task'|'terminal',title:string,caption:string|null,detail:string|null,status:StatusKey,agents:string[],agentNames?:Record<string,string>,updatedAt:number}} HomeRow */

/**
 * 同 App 的 statusOf(apps/app/src/view/status.ts):等你另算,这里只看任务自己。
 * 多一条桌面才看得到的:老 daemon 不给 phase 时,会话留着、前台空着、后台也没活 ⇒ 这一轮做完了(同 workbench-runtime.js 的「会话保留中」)。
 * @param {{status:string,phase?:string,runtime?:{retained?:boolean,foreground?:string,backgroundCount?:number}}} task @returns {StatusKey}
 */
export function taskStatusKey({ status, phase, runtime }) {
  if (phase === 'failed' || status === 'failed') return 'failed'
  if (status === 'cancelled' || phase === 'cancelled' || status === 'interrupted' || phase === 'interrupted') return 'stopped'
  if (phase === 'replied') return 'replied'
  if (status === 'completed' || phase === 'completed' || phase === 'done') return 'done'
  if (!phase && status === 'running' && runtime?.retained && runtime.foreground === 'idle' && !count(runtime.backgroundCount)) return 'replied'
  return 'working'
}

/** 终端会话:在跑 ⇒ 在做,歇着 ⇒ 这一轮做完了(同 App 的 terminalStatusKey)。 @param {string} s @returns {StatusKey} */
const sessionStatusKey = s => s === 'running' ? 'working' : s === 'idle' ? 'replied' : 'done'

const back = (/** @type {StatusKey} */ s) => STATUS_TABLE[s].group === 'back'

/**
 * @param {{tasks:HomeTask[]|null,attention:{tasks:Array<{id:string}>,stale:boolean}|null,sessions:HomeSession[],now:number,agentNames?:Record<string,string>,backWindowMs?:number|null}} input
 * @returns {{working:HomeRow[],back:HomeRow[],moreCount:number}}
 */
export function homeGroups(input) {
  const { now } = input
  // 等你以 attention 为准(读到了就只信它);读不到时退回列表里的计数 —— 宁可这一行暂时不出,也不说它在做。
  const fresh = input.attention && !input.attention.stale ? new Set(input.attention.tasks.map(t => t.id)) : null
  const waiting = (/** @type {HomeTask} */ t) => fresh ? fresh.has(t.id) : count(t.pendingPermissionCount) + count(t.pendingQuestionCount) > 0
  /** @type {HomeRow[]} */
  const rows = []
  for (const t of input.tasks ?? []) {
    if (t.archivedAt != null || waiting(t)) continue
    const status = t.importedOnly ? 'stopped' : taskStatusKey(t)
    rows.push({
      id: t.id, source: 'task', title: t.title || '未命名任务',
      // 在做却 30 分钟没动静 ⇒「可能卡住」(三端同一句,状态表里;和微信日报同一条线)
      caption: t.importedOnly ? '还没开始做' : back(status) ? STATUS_WORDS[status] : status === 'working' && now - t.updatedAt > QUIET_AFTER_MS ? ROW_HINT_WORDS.quiet : null,
      detail: null, status,
      agents: AGENTS.matterAgents(t.providerId, t.agents),
      ...(input.agentNames ? { agentNames: input.agentNames } : {}),
      updatedAt: t.updatedAt,
    })
  }
  for (const s of input.sessions) {
    if (s.status === 'ended' || s.status === 'waiting') continue
    const status = sessionStatusKey(s.status)
    const at = typeof s.last_event_at === 'number' ? s.last_event_at : now
    const ago = formatRelativeTime(new Date(at).toISOString(), now)
    const word = s.stale ? '有一阵没动静了' : back(status) ? STATUS_WORDS[status] : null
    // 没写 source 的是老 daemon(那时只有 Claude);名字由 daemon 定(displayName),没给 ⇒ 头像那边退回 id。
    const agent = typeof s.source === 'string' && s.source.trim() ? s.source.trim() : 'claude'
    const step = s.now?.text?.trim() || s.last_summary?.trim() || null
    rows.push({
      id: s.session_id, source: 'terminal', title: s.project || '终端会话',
      caption: [word, ago].filter(Boolean).join(' · ') || null,
      detail: s.stale ? null : step,
      status,
      agents: [agent],
      ...(typeof s.displayName === 'string' && s.displayName ? { agentNames: { [agent]: s.displayName } } : {}),
      updatedAt: at,
    })
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  const backAll = rows.filter(r => back(r.status))
  const windowMs = input.backWindowMs === undefined ? BACK_WINDOW_MS : input.backWindowMs
  const backRecent = windowMs === null ? backAll : backAll.filter(r => r.updatedAt >= now - windowMs)
  return { working: rows.filter(r => r.status === 'working'), back: backRecent, // 「全部」(一起做那一页)只列一件件事:窗口外的终端会话不列也不数,免得许诺一个找不到的数
  moreCount: backAll.filter(r => r.source === 'task').length - backRecent.filter(r => r.source === 'task').length }
}
