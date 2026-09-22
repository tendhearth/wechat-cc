// @ts-check

/** 工作台实时流的纯函数(spec §8):事件合并、结构签名、live 组增量补丁、长轮询循环。
 * 这里不碰 document / window —— 补丁只用调用方递进来的节点,便于在没有 DOM 的测试里验证。 */

/** @typedef {import('./workbench.js').WorkbenchEvent} WorkbenchEvent */
/** @typedef {import('./workbench.js').Detail} Detail */

/** 同一行会被追加文字 / 翻状态:按 id 覆盖,保留原来的位置;新行按 id 升序插进去。
 * @param {WorkbenchEvent[]} existing @param {WorkbenchEvent[]} incoming @returns {WorkbenchEvent[]} */
export function mergeEvents(existing, incoming) {
  if (!incoming?.length) return existing
  const byId = new Map(existing.map((event, index) => [event.id, index]))
  const out = existing.slice()
  /** @type {WorkbenchEvent[]} */ const fresh = []
  for (const event of incoming) {
    const index = byId.get(event.id)
    if (index === undefined) fresh.push(event)
    else out[index] = event
  }
  if (!fresh.length) return out
  return [...out, ...fresh].sort((a, b) => Number(a.id) - Number(b.id))
}

/** 整页重画的判据:事件之外的一切。事件只改时间线,交给增量补丁。
 * `waitingFor.closeInMs` 是后端按 `Date.now()` 现算的,不摘掉的话:主人正看着排队任务(这个
 * 功能的目标场景)时,只要长轮询在计时武装期间收一轮,签名就变,`applyLiveDetail` 判定
 * `restructured` 后直接 `paint(true)` 无条件全量重画,绕过 `paintKey()` 那道去重(评审 #2,
 * 和上一轮 `paintKey()` 打的是同一个补丁——真转变仍落在 `holderWriting`/`reason`/`taskId`
 * 上,没被摘,该重画时照样重画)。
 * @param {Detail|null|undefined} detail */
export function structuralSignature(detail) {
  if (!detail) return ''
  const task = detail.task ?? {}
  return JSON.stringify([
    task.status ?? null, task.phase ?? null, task.error ?? null, task.archivedAt ?? null,
    // null(没有计时器)与非 null(已武装)是两种不同的状态,抹平成同一个 0 会把这个真转变
    // 去重吞掉(终审 M1);0 只代表「已武装、数字不重要」,null 保留 null。
    task.waitingFor ? { ...task.waitingFor, closeInMs: task.waitingFor.closeInMs == null ? null : 0 } : null,
    detail.runId ?? null, detail.inputMode ?? null,
    (detail.permissions ?? []).map(p => p.id),
    (detail.questions ?? []).map(q => q.id),
    (detail.artifacts ?? []).map(a => [a.id, a.sha256]),
    (detail.inputs ?? []).map(i => [i.id, i.status]),
    detail.runtime ?? null,
    (detail.attachments ?? []).length,
    detail.execution ?? null, detail.lastExecution ?? null, detail.continuation ?? null,
    (detail.handoffs ?? []).length,
    detail.requiresExternalClose ?? null,
  ])
}

/** @typedef {{eventId:(event:WorkbenchEvent)=>string,message:(event:WorkbenchEvent)=>string,operation:(event:WorkbenchEvent)=>string}} PatchRenderers */
/** @typedef {{patched:number,appended:number,missing:number}} PatchResult */

const isMessage = (/** @type {WorkbenchEvent} */ event) => event.kind === 'user' || event.kind === 'text'
/** 整页渲染会把这些行提到组外(workbench-timeline.js 的 visibleIssue):补丁塞不回正确的位置。 */
const hoisted = (/** @type {WorkbenchEvent} */ event) => event.kind === 'error' || ['failed', 'cancelled', 'interrupted'].includes(event.activity?.status ?? '')

/** 正在跑的那一组的操作列表 —— 必须是对话区的最后一个孩子,否则追加会把新操作
 * 塞到上面那一组里(渲染器每遇到一条消息就断开一组,同一轮可以有好几个 live 组)。
 * @param {{querySelector:(selector:string)=>any}} root */
function liveOperationList(root) {
  const dialogue = root.querySelector('.wb-dialogue')
  if (!dialogue) return null
  const groups = Array.from(dialogue.querySelectorAll?.('[data-timeline-group]:not(details)') ?? [])
  const group = groups.at(-1)
  if (!group || dialogue.lastElementChild !== group) return null
  return group.querySelector?.('.wb-operation-list') ?? null
}

/** 把变过的事件写回正在跑的那一组:能原位换掉就换,能安全追加就追加。
 * 位置对不上、要提到组外、或者那一行里有展开着的详情(焦点救不回来)就记 missing,
 * 调用方退回整页重画。
 * @param {{querySelector:(selector:string)=>any}} root @param {WorkbenchEvent[]} changed @param {PatchRenderers} render @returns {PatchResult} */
export function patchLiveTimeline(root, changed, render) {
  let patched = 0, appended = 0, missing = 0
  for (const event of changed ?? []) {
    if (hoisted(event)) { missing++; continue }
    const html = isMessage(event) ? render.message(event) : render.operation(event)
    const existing = root.querySelector(`#${render.eventId(event)}`)
    if (existing) {
      if (existing.querySelector?.('[data-timeline-disclosure][open], details[open]')) { missing++; continue }
      existing.outerHTML = html
      patched++
      continue
    }
    // 每条都重新找一次:上一条刚追加的消息会把 live 组从末尾挤走。
    const host = isMessage(event) ? root.querySelector('.wb-dialogue') : liveOperationList(root)
    if (host) { host.insertAdjacentHTML('beforeend', html); appended++ } else missing++
  }
  return { patched, appended, missing }
}

/** @typedef {{fetchDetail:(id:string,since:number,waitMs:number)=>Promise<any>,onDetail:(detail:any)=>void,onError?:(error:unknown)=>void,waitMs?:number,backoff?:number[]}} LongPollOptions */
/** @typedef {{start:(id:string,version?:number)=>void,stop:()=>void,readonly active:boolean}} LongPoll */

/** 长轮询循环:一次请求挂到后台有新东西为止,回来就接着下一次。
 * since 永远取上一次响应里的 version —— 后台回卷最多重放一行(按 id 合并),不会漏。
 * @param {LongPollOptions} options @returns {LongPoll} */
export function createLongPoll({ fetchDetail, onDetail, onError, waitMs = 20000, backoff = [1000, 2000, 5000, 10000] }) {
  let generation = 0
  let running = false
  /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null
  const halt = () => { running = false; if (timer) { clearTimeout(timer); timer = null } }
  /** @param {string} id @param {number} version @param {number} mine @param {number} failures */
  const loop = async (id, version, mine, failures) => {
    if (mine !== generation) return
    /** @type {any} */ let detail
    try { detail = await fetchDetail(id, version, waitMs) }
    catch (error) {
      if (mine !== generation) return
      onError?.(error)
      timer = setTimeout(() => { timer = null; void loop(id, version, mine, failures + 1) }, backoff[Math.min(failures, backoff.length - 1)] ?? 1000)
      return
    }
    if (mine !== generation) return
    onDetail(detail)
    // onDetail 可能换任务(重新 start)或直接 stop:那一刻这条腿就该死掉。
    if (mine !== generation) return
    // 旧后台不带 version:再问一次只会立刻回来,白转;停在这里,退回 3 秒重拉。
    if (typeof detail?.version !== 'number') { halt(); return }
    timer = setTimeout(() => { timer = null; void loop(id, detail.version, mine, 0) }, 0)
  }
  return {
    get active() { return running },
    start(id, version = 0) {
      halt()
      running = true
      const mine = ++generation
      void loop(id, version, mine, 0)
    },
    stop() { generation++; halt() },
  }
}
