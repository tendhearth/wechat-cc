// 「待办」(收敛清单 ④,2026-10-21,从手机网页搬来)的纯视图模型:在办的每条带「完成」,最近了结的收起、每条带「捞回」。
// 文字照原网页(home.js 的待办,收敛 5b 删了网页那页):空 ⇒「都了结了」+ 小字;了结那一组叫「最近了结」;改成了 ⇒「划掉了 / 捞回来了」。
// 超时不说「没改成」—— 也许已经改了只是回执丢了,单独说「不确定」。纯 TS,不碰 react / expo。
import type { PocketT, TodoRowT, TodoStatus } from '../backend/types'
import { t, type Lang, type MessageKey } from '../i18n'

export type TodoItem = { id: number; text: string; /** 跟谁 · 什么时候(聊天里说的),没有时间就只有人。 */ meta: string }
export type TodosView = {
  active: TodoItem[]
  settled: TodoItem[]
  /** 在办的一条都没有 ⇒ 那两句;有 ⇒ null。 */
  empty: { line: string; hint: string } | null
  /** 了结那一组的折叠行;没有了结的 ⇒ null(不画)。 */
  settledToggle: string | null
}

const item = (r: TodoRowT): TodoItem => ({ id: r.id, text: r.value, meta: r.time_ref ? `${r.display} · ${r.time_ref}` : r.display })

export function todosView(todos: PocketT['todos'], lang: Lang): TodosView {
  return {
    active: todos.active.map(item),
    settled: todos.settled.map(item),
    empty: todos.active.length ? null : { line: t(lang, 'todos.empty'), hint: t(lang, 'todos.emptyHint') },
    settledToggle: todos.settled.length ? t(lang, 'todos.settled', { n: todos.settled.length }) : null,
  }
}

/** 动作的结果 → 那一句灰字。ok ⇒ 划掉了 / 捞回来了;同一条正在改(busy)⇒ 不说;超时 ⇒ 不确定;其余 ⇒ 没改成。 */
export function todoActionNote(status: TodoStatus, r: 'ok' | 'busy' | { error: string }): MessageKey | null {
  if (r === 'busy') return null
  if (r === 'ok') return status === 'resolved' ? 'todos.doneNote' : 'todos.restoredNote'
  if (r.error === 'uncertain') return 'todos.uncertain'
  return 'todos.failed'
}
