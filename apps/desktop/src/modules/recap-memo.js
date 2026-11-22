// @ts-check
import { escapeWorkbenchHtml as esc } from './workbench-markdown.js'

/** @param {number} ms */
function awayTime(ms) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时`
  return `${Math.floor(minutes / 1440)} 天`
}

/** @param {import('@wechat-cc/protocol').SessionRecapT} recap */
export function recapMemoHtml({ source, text, awayMs }) {
  const credit = source === 'claude' ? '这是 Claude Code 自己记的' : 'CC 留了张条'
  return `<aside class="thing-recap" data-recap-source="${source === 'claude' ? 'claude' : 'cc'}">
    <svg aria-hidden="true"></svg><small>你 ${awayTime(awayMs)}没来，${credit}</small><p>${esc(text)}</p></aside>`
}

/** @param {HTMLElement} memo @param {string} id */
export function sketchRecap(memo, id) {
  const svg = memo.querySelector('svg')
  const { offsetWidth: width, offsetHeight: height } = memo
  if (!svg || !width || !height) return
  let seed = [...id].reduce((n, char) => (n * 31 + char.charCodeAt(0)) >>> 0, 7)
  const jitter = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) - 0.5
  /** @param {number} shake */
  function ring(shake) {
    const left = 2, top = 2, right = width - 2, bottom = height - 2
    const radius = Math.min(9, (right - left) / 3, (bottom - top) / 3)
    const corner = radius * 0.28
    /** @type {[number, number][]} */
    const points = []
    /** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
    function edge(ax, ay, bx, by) {
      const count = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 64))
      for (let i = 0; i <= count; i++) {
        points.push([ax + (bx - ax) * i / count + jitter() * shake, ay + (by - ay) * i / count + jitter() * shake])
      }
    }
    edge(left + radius, top, right - radius, top)
    points.push([right - corner, top + corner])
    edge(right, top + radius, right, bottom - radius)
    points.push([right - corner, bottom - corner])
    edge(right - radius, bottom, left + radius, bottom)
    points.push([left + corner, bottom - corner])
    edge(left, bottom - radius, left, top + radius)
    points.push([left + corner, top + corner])

    const length = points.length
    /** @param {number} x @param {number} y */
    const point = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`
    // There are at least two samples on each edge and one at each corner.
    /** @param {number} i @returns {[number, number]} */
    const at = i => /** @type {[number, number]} */ (points[(i + length) % length])
    let path = `M${point(...at(0))}`
    for (let i = 0; i < length; i++) {
      const a = at(i - 1), b = at(i), c = at(i + 1), d = at(i + 2)
      path += `C${point(b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6)} ${point(c[0] - (d[0] - b[0]) / 6, c[1] - (d[1] - b[1]) / 6)} ${point(...c)}`
    }
    return path + 'Z'
  }
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.innerHTML = `<path d="${ring(2.4)}"/><path d="${ring(3)}" opacity=".5"/>`
}
