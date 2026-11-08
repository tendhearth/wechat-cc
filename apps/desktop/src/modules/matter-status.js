// @ts-check
// matter-status.js — 一件事的状态 ⇒ 状态表里的哪一格、行首画什么(设计稿 2026-10-31 §4 U4,桌面一套语言 2026-11-05)。无副作用。
// 主页(now-page.js)、「全部」与详情(workbench.js)都从这里拿,别各自写一份映射:
// 词条 / 图标 / 色调 / 分组的源头是 packages/protocol/src/status-table.ts(生成物 ../generated/status-table.js)。
import { STATUS_TABLE } from '../generated/status-table.js'
import { icon } from './icons.js'

/** @typedef {import('../generated/status-table.js').StatusKey} StatusKey */

// 状态表的图标名 ⇒ 桌面这套图标里最接近的那个;在做不画(同 App,行里留空位)。
/** @type {Record<string,string>} */
export const STATUS_ICON = { shield: 'square-lock-01', done: 'checkmark-circle-02', alert: 'alert-02', message: 'mail-01', pause: 'stop' }

const count = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0

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

/**
 * 「全部」与详情用的:有待批权限 / 待答问题 ⇒ 等你;只是导入、还没执行过 ⇒ 停下了(同主页那一行)。
 * @param {{status:string,phase?:string,runtime?:any,importedOnly?:boolean,archivedAt?:number|null,pendingPermissionCount?:number,pendingQuestionCount?:number}} task @returns {StatusKey}
 */
export function workbenchTaskStatusKey(task) {
  if (task.archivedAt == null && count(task.pendingPermissionCount) + count(task.pendingQuestionCount) > 0) return 'waiting'
  if (task.importedOnly) return 'stopped'
  return taskStatusKey(task)
}

/**
 * 行首 / 详情标题下那一格记号:状态表给的图标,色调也照表(只有「等你」是强调色);在做留空位。
 * 记号本身不出声,状态词写在旁边的文字里。
 * @param {StatusKey} key @param {number} [size]
 */
export function statusGlyphHtml(key, size = 16) {
  const spec = STATUS_TABLE[key]
  const name = spec.icon ? STATUS_ICON[spec.icon] : null
  return `<span class="now-row-status" data-tone="${spec.tone}" aria-hidden="true">${name ? icon(name, { size }) : ''}</span>`
}
