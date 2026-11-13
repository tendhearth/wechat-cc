// @ts-check
// Local checkup only. Preparing an estimate never starts model requests.
import { V1, v1 } from '../daemon-client.js'

/** @typedef {{target:unknown,profile:null|{memory:'good'|'fair'|'weak',tools:'stable'|'flaky',testedAt:string,short:boolean},attempt:null|{status:'running'|'completed'|'failed'|'cancelled'},suspectedChanged:boolean,periodicProbe:boolean}} CheckupView */
/** @typedef {{requests:number,maxRequests:number,inputTokens:number,outputTokens:number,windowKnown:boolean,targetKey:string}} Estimate */
/** @param {string} tag @param {string} text @param {string} [cls] */
function el(tag, text, cls) { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n }

/** @param {CheckupView} data */
export function butlerSummary(data) {
  const p = data.profile
  return {
    memory: p ? { good: '好', fair: '一般', weak: '弱' }[p.memory] : '还没体检',
    tools: p ? p.tools === 'stable' ? '稳' : '偶尔出错' : '还没体检',
    note: p?.memory === 'weak' ? 'CC 会更常跟你确认。' : !p ? '体检后，CC 会更了解自己的记性和用工具的情况。' : '',
    tested: p ? `上次体检 ${new Date(p.testedAt).toLocaleString('zh-CN')}${p.short ? ' · 短版' : ''}` : '',
    attempt: data.attempt?.status === 'running' ? '正在体检，可以随时停下。' : data.attempt?.status === 'failed' ? '这次没测成，已有的体检结果保留。' : data.attempt?.status === 'cancelled' ? '已取消，已有的体检结果保留。' : '',
  }
}

/** @param {{host:HTMLElement,call:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>}} o */
export function mountButlerStatus({ host, call }) {
  /** @type {CheckupView|null} */ let data = null
  /** @type {Estimate|null} */ let estimate = null
  let busy = false, failed = false, alive = true
  let target = '', ticket = 0, actionError = ''
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer
  const button = (/** @type {string} */ label, /** @type {string} */ id, /** @type {()=>void} */ action) => {
    const b = /** @type {HTMLButtonElement} */ (el('button', label, 'nc-action')); b.setAttribute('type', 'button'); b.dataset.checkup = id; b.disabled = busy || (failed && !['retry', 'cancel', 'dismiss'].includes(id)); b.addEventListener('click', action); return b
  }
  const line = (/** @type {string} */ name, /** @type {string} */ detail) => {
    const li = el('li', '', 'nc-row'); li.append(el('span', name, 'nc-name'), el('span', detail, 'nc-detail')); return li
  }
  function render() {
    host.className = 'nc-section nc-butler'
    const nodes = [el('h3', '管家状态', 'nc-section-title')]
    if (!data) {
      nodes.push(el('p', failed ? '暂时读不到管家状态。' : '正在查看管家状态。', 'nc-detail'))
      if (failed) nodes.push(button('再试一次', 'retry', () => { void refresh() }))
      host.replaceChildren(...nodes); return
    }
    const s = butlerSummary(data), running = data.attempt?.status === 'running'
    const list = el('ul', '', 'nc-list'); list.append(line('记性', s.memory), line('用工具', s.tools)); nodes.push(list)
    for (const text of [actionError, s.note, s.tested, s.attempt, data.suspectedChanged ? '可能被换了，建议重新体检。' : '', failed ? '暂时读不到最新状态，下面是上次所知。' : '']) if (text) nodes.push(el('p', text, 'nc-detail'))
    if (failed) nodes.push(button('再试一次', 'retry', () => { void refresh() }))
    if (running) nodes.push(button('取消体检', 'cancel', () => { void perform(async () => { data = /** @type {CheckupView} */ (await v1(call, V1.checkup.cancel, { body: {} })); estimate = null }) }))
    else if (estimate) {
      const quote = el('p', `短版体检通常几分钟：约 ${estimate.requests} 次请求（含重试最多 ${estimate.maxRequests} 次），约 ${estimate.inputTokens} 输入、${estimate.outputTokens} 输出 token。只用编造的对话。${estimate.windowKnown ? '' : '窗口未知，按保守大小估算。'}`, 'nc-detail')
      quote.dataset.checkup = 'estimate'; nodes.push(quote)
      nodes.push(button('开始体检', 'start', () => { void perform(async () => { data = /** @type {CheckupView} */ (await v1(call, V1.checkup.run, { body: { full: false, expectedTargetKey: estimate?.targetKey } })); estimate = null }) }))
      nodes.push(button('先不测', 'dismiss', () => { estimate = null; render() }))
    } else nodes.push(button(data.profile ? '重新体检' : '体检', 'prepare', () => { void perform(async () => { estimate = /** @type {Estimate} */ (await v1(call, V1.checkup.estimate, { body: { full: false } })) }) }))
    const label = el('label', '', 'nc-detail'), toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = data.periodicProbe; toggle.disabled = busy || running || failed; toggle.dataset.checkup = 'periodic'
    toggle.addEventListener('change', () => { const enabled = toggle.checked; void perform(async () => { data = /** @type {CheckupView} */ (await v1(call, V1.checkup.settings, { body: { periodicProbe: enabled } })) }) })
    label.append(toggle, document.createTextNode(' 定期小量复查（会用少量额度）')); nodes.push(label)
    host.replaceChildren(...nodes)
  }
  async function perform(/** @type {()=>Promise<void>} */ action) {
    if (busy) return
    ++ticket; busy = true; actionError = ''; render()
    try { await action(); failed = false } catch (e) {
      estimate = null; failed = true
      const code = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
      actionError = code.includes('checkup_target_changed') || code === 'stale' ? 'CC 用的模型或连接变了，请重新确认体检用量。'
        : code.includes('checkup_busy') || code === 'busy' ? '体检已经在做了，请稍等，或先取消这一轮。'
        : code.includes('checkup_invalid_request') ? '这次体检没能开始，请重新打开体检再试。'
        : '这次体检操作没做成，请再试一次。'
    }
    finally { busy = false; if (alive) { render(); schedule(); if (failed) void refresh() } }
  }
  function schedule() {
    clearTimeout(timer)
    if (alive && data?.attempt?.status === 'running') timer = setTimeout(() => { void refresh() }, 2_000)
  }
  async function refresh() {
    if (!alive || busy) return
    const mine = ++ticket
    try {
      const next = /** @type {CheckupView} */ (await v1(call, V1.checkup.get))
      if (!alive || mine !== ticket) return
      if (!next || typeof next.periodicProbe !== 'boolean') throw new Error('invalid_checkup')
      const nextTarget = JSON.stringify(next.target) ?? ''
      if (target !== nextTarget) estimate = null
      target = nextTarget; data = next; failed = false
    } catch { if (!alive || mine !== ticket) return; failed = true }
    render(); schedule()
  }
  render()
  return { refresh, destroy() { alive = false; ++ticket; clearTimeout(timer) } }
}
