// @ts-check
import { balanceBranches, leafId } from './lab-map-model.js'
import { placeTime } from './places-strip.js'

/** @typedef {import('@wechat-cc/protocol').PlaceOutlineT} Outline */
/** @typedef {import('@wechat-cc/protocol').PlaceOutlineSourceT} Source */
/** @typedef {NonNullable<Outline['aspects']>[number]['items'][number]} Leaf */

/** @param {string} name @param {NonNullable<Outline['aspects']>} aspects */
export function outlineData(name, aspects) {
  const children = aspects.map((aspect, index) => ({
    id: `g:aspect-${index}`, topic: aspect.name, branchColor: 'var(--th-desk-line)',
    children: aspect.items.map(leaf => ({ id: leafId(leaf.id), topic: leaf.line })),
  }))
  return { nodeData: { id: 'root', topic: name, children: balanceBranches(children) } }
}

/** @param {number|undefined} at @param {number} now */
const time = (at, now) => at !== undefined ? placeTime({ moving: false, updatedAt: at }, now) : ''

/** 第一处出处那一行带上「CC 梳理的」;后面几处只写出自哪。 @param {Source} source @param {boolean} canJump @param {number} now @param {boolean} [first] */
export function outlineSource(source, canJump, now, first = true) {
  const entry = source.kind === 'entry'
  const from = entry ? '出自 CC 记下的一条' : source.agent ? `出自 ${source.agent} 的会话` : '出自终端会话'
  return {
    text: [...(first ? ['CC 梳理的'] : []), from, time(source.at, now)].filter(Boolean).join('，'),
    jump: !entry && canJump,
    missing: !entry && !canJump,
  }
}

/** @param {number|undefined} at @param {number} now */
function outlineDay(at, now) {
  if (at === undefined) return ''
  const date = new Date(at), today = new Date(now)
  if (date.toDateString() === today.toDateString()) return '今天'
  // Compare calendar dates at noon so a result before midnight reads 「昨天」.
  return time(date.setHours(12, 0, 0, 0), today.setHours(12, 0, 0, 0))
}

/** @param {Outline} outline @param {number} now */
export function outlineNotice(outline, now) {
  switch (outline.state) {
    case 'none': return { text: 'CC 还没梳理过这件事。', action: outline.canRun ? '让 CC 梳理一下' : '' }
    case 'running': return { text: 'CC 在梳理…', action: '' }
    case 'ready': return {
      text: `CC ${outlineDay(outline.at, now)}梳理的` + (outline.stale && !outline.canRun ? '。今天梳理过了。' : ''),
      action: outline.stale && outline.canRun ? '重新梳理' : '',
    }
    case 'empty': return {
      text: '材料太少，CC 没分出几块。' + (outline.stale && !outline.canRun ? '今天梳理过了。' : ''),
      action: outline.stale && outline.canRun ? '重新梳理' : '',
    }
    case 'failed': return {
      text: '这次没梳理出来。',
      reason: !outline.canRun ? '今天试过几次都没成，明天再试。'
        : outline.error === 'no_private_model' ? '现在没有可用的私密模型。' : '',
      action: outline.canRun && outline.error !== 'no_private_model' ? '再试一次' : '',
    }
  }
}
