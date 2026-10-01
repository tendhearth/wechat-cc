// @ts-check
/// <reference lib="dom" />
/**
 * 「连接手机」(spec 2026-10-01-tendhearth-pairing-ux §4.3、§5):设置抽屉的弹层与引导页最后一步共用一个流程。
 * daemon:POST /v1/phone/link(必要时打开远程隧道;只在 v2 中继就绪时出码)、GET /v1/phone/devices(轮询「已连上」)。
 * 两条都是 admin,经原生宿主的 operator 凭据(invokeWorkbenchApi),渲染进程拿不到令牌。设备名是用户内容,一律 textContent。
 */
import { phoneCopy as c } from './phone-connect-copy.js'

/** @typedef {'ready'|'starting'|'remote_off'|'relay_not_configured'|'relay_unavailable'|'no_owner'} LinkState */
/** @typedef {{ ok: true, state: 'ready', url: string, expires_at: number, check_code?: string } | { ok: false, state: Exclude<LinkState, 'ready'> }} LinkResult */
/** @typedef {{ id: string, label?: string, created_at: string, last_seen_at: string }} Device */
/** @typedef {{ kind: 'loading' } | { kind: 'qr', url: string, expiresAt: number, checkCode: string | null } | { kind: 'starting' } | { kind: 'notice', title: string, body: string } | { kind: 'expired' } | { kind: 'paired', line: string } | { kind: 'error', text: string }} View */
/** @typedef {(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<unknown>} Call */
/** @typedef {{ now?: () => number, sleep?: (ms: number) => Promise<void>, pollMs?: number, startTimeoutMs?: number, labelWaits?: number }} FlowTuning */

/** @param {LinkResult} r @returns {View} */
export function linkView(r) {
  if (r.ok) return { kind: 'qr', url: r.url, expiresAt: r.expires_at, checkCode: checkCodeOf(r.check_code) }
  switch (r.state) {
    case 'starting': return { kind: 'starting' }
    case 'relay_not_configured': return { kind: 'notice', title: c.relayNotConfiguredTitle, body: c.relayNotConfiguredBody }
    case 'relay_unavailable': return { kind: 'notice', title: c.relayUnavailableTitle, body: c.relayUnavailableBody }
    case 'remote_off': return { kind: 'notice', title: c.remoteOffTitle, body: c.remoteOffBody }
    case 'no_owner': return { kind: 'notice', title: c.noOwnerTitle, body: '' }
    default: return { kind: 'error', text: c.error.replace('{why}', 'unknown_state') }
  }
}

/**
 * 核对码(Task 9 fix round 1):daemon 用 @wechat-cc/protocol 的 pairCheckCode(daemon id) 算好随码一起给;
 * 手机确认卡上显示同一个。官方中继是大家共用的,只看主机名分不清「我的电脑」和「别人的码」。
 * 只认 XXX-XXX 形式的 6 个不易看错的字符(与 protocol PAIR_CHECK_RE 相同);缺了或畸形 ⇒ null,不显示。
 * @param {unknown} v @returns {string | null}
 */
export function checkCodeOf(v) {
  return typeof v === 'string' && /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/.test(v) ? v : null
}

/** 出码前快照里没有的 id 才算新;多台取最新创建的。 @param {Set<string>} before @param {Device[]} now @returns {Device | null} */
export function newDevice(before, now) {
  const fresh = now.filter(d => !before.has(d.id))
  if (fresh.length === 0) return null
  return [...fresh].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
}

/** @param {Device} d */
export function pairedLine(d) {
  return d.label ? c.paired.replace('{label}', d.label) : c.pairedNoLabel
}

/** @param {unknown} err */
const why = err => (err instanceof Error ? err.message : String(err))

/**
 * 一次「连接手机」:要码(必要时等 daemon 重启)→ 出码 → 盯设备列表 → 连上 / 过期。
 * start() 重入即重来(旧的那一轮自动作废);stop() 之后不再回调。
 * @param {{ call: Call, onView: (v: View) => void } & FlowTuning} deps
 */
export function makePhoneLinkFlow(deps) {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const pollMs = deps.pollMs ?? 2000
  const startTimeoutMs = deps.startTimeoutMs ?? 45_000
  let run = 0
  /** @returns {Promise<Device[] | null>} */
  const devices = async () => {
    try {
      const r = /** @type {{ ok?: boolean, devices?: Device[] }} */ (await deps.call('GET', '/v1/phone/devices'))
      return r && r.ok && Array.isArray(r.devices) ? r.devices : null
    } catch { return null }
  }
  async function start() {
    const mine = ++run
    const alive = () => mine === run
    /** @param {View} v */
    const show = v => { if (alive()) deps.onView(v) }
    show({ kind: 'loading' })
    const first = await devices()
    /** @type {Set<string> | null} */
    let baseline = first ? new Set(first.map(d => d.id)) : null
    const t0 = now()
    let sawStarting = false
    /** @type {{ ok: true, state: 'ready', url: string, expires_at: number, check_code?: string } | null} */
    let ready = null
    // 只有每轮 start() 的第一次 POST 带 enable_remote:之后的轮询只是问状态,不能每 2 秒再要求一次开隧道 / 重启(I1)。
    let firstPost = true
    while (alive()) {
      /** @type {LinkResult} */
      let r
      try {
        const body = firstPost ? { enable_remote: true } : {}
        firstPost = false
        r = /** @type {LinkResult} */ (await deps.call('POST', '/v1/phone/link', body))
      } catch (err) {
        if (!sawStarting) { show({ kind: 'error', text: c.error.replace('{why}', why(err)) }); return }
        r = { ok: false, state: 'starting' }   // daemon 正在重启:连不上是预期的(Review Focus 2)
      }
      if (!alive()) return
      if (r.ok) { ready = r; break }
      if (r.state !== 'starting') { show(linkView(r)); return }
      sawStarting = true
      if (now() - t0 >= startTimeoutMs) { show({ kind: 'notice', title: c.startTimeout, body: '' }); return }
      show({ kind: 'starting' })
      await sleep(pollMs)
    }
    if (!ready || !alive()) return
    show(linkView(ready))
    const issuedAt = now()
    let labelWaits = deps.labelWaits ?? 2
    while (alive()) {
      if (now() >= ready.expires_at) { show({ kind: 'expired' }); return }
      await sleep(pollMs)
      if (!alive()) return
      const list = await devices()
      if (!list) continue
      // 出码前的快照没拿到 ⇒ 不能把「出码后第一次轮询」当基线(那会漏掉缝隙里配上的手机):
      // 改认「创建时间不早于出码时刻」的设备(同一台机器的时钟,守护进程与桌面一致)。
      const d = baseline ? newDevice(baseline, list) : newDevice(new Set(), list.filter(x => Date.parse(x.created_at) >= issuedAt))
      if (!d) continue
      if (!d.label && labelWaits-- > 0) continue
      show({ kind: 'paired', line: pairedLine(d) })
      return
    }
  }
  return { start, stop() { run++ } }
}

/**
 * @param {Document} doc @param {string} tag @param {Record<string, string>} [attrs] @param {string} [text]
 * @returns {HTMLElement}
 */
function el(doc, tag, attrs = {}, text = '') {
  const n = doc.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  if (text) n.textContent = text
  return n
}

/**
 * 设置抽屉的「连接手机」弹层(#phone-settings-modal,一张卡、无阴影)。
 * @param {{ call: Call, renderQr: (text: string) => Promise<string>, writeClipboard?: (text: string) => Promise<void>, flowDeps?: FlowTuning, doc?: Document }} deps
 */
export function mountPhoneConnect(deps) {
  const doc = deps.doc ?? document
  /** @type {HTMLElement | null} */ let modal = null
  /** @type {ReturnType<typeof makePhoneLinkFlow> | null} */ let flow = null
  let seq = 0
  /** @param {KeyboardEvent} ev */
  const onKey = ev => { if (ev.key === 'Escape') close() }
  function close() {
    flow?.stop(); flow = null
    modal?.remove(); modal = null
    doc.removeEventListener('keydown', onKey)
  }
  /** @param {View} v */
  async function render(v) {
    if (!modal) return
    const mine = ++seq
    const body = /** @type {HTMLElement} */ (modal.querySelector('#phone-connect-body'))
    const closeBtn = /** @type {HTMLElement} */ (modal.querySelector('#phone-connect-close'))
    closeBtn.textContent = v.kind === 'paired' ? c.done : c.close
    if (v.kind === 'qr') {
      let svg
      try { svg = await deps.renderQr(v.url) } catch (err) { if (mine === seq) void render({ kind: 'error', text: c.error.replace('{why}', why(err)) }); return }
      if (mine !== seq || !modal) return
      const qr = el(doc, 'div', { id: 'phone-connect-qr', class: 'qr-svg' })
      qr.innerHTML = svg   // render_qr_svg 的产物(Rust 生成),不含用户内容
      const copy = el(doc, 'button', { type: 'button', class: 'btn ghost', id: 'phone-connect-copy' }, c.copyLink)
      copy.addEventListener('click', async () => {
        try { await (deps.writeClipboard ?? (t => navigator.clipboard.writeText(t)))(v.url); copy.textContent = c.copied } catch { /* 复制不了就不改字 */ }
      })
      const check = v.checkCode ? [el(doc, 'p', { class: 'qr-check', id: 'phone-connect-check' }, c.checkCode.replace('{code}', v.checkCode))] : []
      body.replaceChildren(qr, ...check, el(doc, 'p', { class: 'qr-note', id: 'phone-connect-note' }, c.readyNote), el(doc, 'p', { class: 'qr-sub' }, c.readySub), copy)
      return
    }
    if (v.kind === 'loading') body.replaceChildren(el(doc, 'p', { class: 'qr-note' }, c.loading))
    else if (v.kind === 'starting') body.replaceChildren(el(doc, 'p', { class: 'qr-note', id: 'phone-connect-starting' }, c.starting))
    else if (v.kind === 'notice') body.replaceChildren(el(doc, 'p', { class: 'qr-notice', id: 'phone-connect-notice' }, v.title), ...(v.body ? [el(doc, 'p', { class: 'qr-note' }, v.body)] : []))
    else if (v.kind === 'error') body.replaceChildren(el(doc, 'p', { class: 'qr-note', id: 'phone-connect-error' }, v.text))
    else if (v.kind === 'paired') body.replaceChildren(el(doc, 'p', { class: 'qr-paired', id: 'phone-connect-paired' }, v.line))
    else if (v.kind === 'expired') {
      const renew = el(doc, 'button', { type: 'button', class: 'btn ghost', id: 'phone-connect-renew' }, c.renew)
      renew.addEventListener('click', () => { void flow?.start() })
      body.replaceChildren(el(doc, 'p', { class: 'qr-note', id: 'phone-connect-expired' }, c.expired), renew)
    }
  }
  return {
    open() {
      close()
      modal = el(doc, 'div', { id: 'phone-settings-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'phone-connect-title' })
      const card = el(doc, 'div', { class: 'qr-card' })
      const closeBtn = el(doc, 'button', { type: 'button', class: 'btn ghost', id: 'phone-connect-close' }, c.close)
      closeBtn.addEventListener('click', close)
      card.append(el(doc, 'h2', { id: 'phone-connect-title' }, c.title), el(doc, 'div', { id: 'phone-connect-body' }), closeBtn)
      modal.append(card)
      modal.addEventListener('click', ev => { if (ev.target === modal) close() })
      doc.addEventListener('keydown', onKey)
      doc.body.append(modal)
      flow = makePhoneLinkFlow({ ...(deps.flowDeps ?? {}), call: deps.call, onView: v => { void render(v) } })
      void flow.start()
    },
    close,
  }
}

/**
 * 引导页最后一步(#screen-service)的码(spec §5):只有拿到 ready 的码才显示整块;别的状态整块藏着;永不挡「进入控制台」。
 * sync({ active, alive }):在这一步且 daemon 活着 ⇒ 开始(只开一次);离开这一步 ⇒ 停、藏。
 * 第一次没拿到码(出错 / 中继没就绪 / 等超时)⇒ 在这一步里有界重试:窗口重新聚焦、以及每 retryMs 一次;
 * 码一旦在显示(或已连上 / 已过期等用户点「换一个」),就不再重试——每次 POST 都会作废上一个码,之后只轮询设备列表。
 * @param {{ host: HTMLElement, call: Call, renderQr: (text: string) => Promise<string>, flowDeps?: FlowTuning, retryMs?: number }} deps
 */
export function mountOnboardPhone(deps) {
  const { host } = deps
  const retryMs = deps.retryMs ?? 30_000
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (host.querySelector(`#${id}`))
  $('onboard-phone-title').textContent = c.title
  $('onboard-phone-later').textContent = c.later
  const renew = $('onboard-phone-renew')
  renew.textContent = c.renew
  const check = /** @type {HTMLElement | null} */ (host.querySelector('#onboard-phone-check'))
  /** @param {string | null} code */
  const setCheck = code => { if (!check) return; check.textContent = code ? c.checkCode.replace('{code}', code) : ''; check.hidden = !code }
  let started = false
  let needsRetry = false
  let seq = 0
  /** @type {ReturnType<typeof setInterval> | null} */ let timer = null
  /** @param {View} v */
  async function show(v) {
    if (!started) return   // 离开这一步之后迟到的视图不能再把整块亮出来
    const mine = ++seq
    needsRetry = v.kind === 'error' || v.kind === 'notice'
    if (v.kind === 'loading') return   // 还不知道有没有码:藏着,不闪
    if (v.kind !== 'qr') setCheck(null)
    if (v.kind === 'starting') {       // 自动打开手机连接会让 CC 重启一次:说出来(D4)
      $('onboard-phone-qr').replaceChildren(); $('onboard-phone-status').textContent = c.preparing
      renew.hidden = true; host.hidden = false
      return
    }
    if (v.kind === 'qr') {
      let svg
      try { svg = await deps.renderQr(v.url) } catch { needsRetry = true; return }
      if (mine !== seq || !started) return
      $('onboard-phone-qr').innerHTML = svg   // render_qr_svg 的产物,不含用户内容
      $('onboard-phone-status').textContent = c.readyNote
      setCheck(v.checkCode)
      renew.hidden = true
      host.hidden = false
      return
    }
    // 连上 / 过期只会发生在出过码之后
    if (v.kind === 'paired') { $('onboard-phone-qr').replaceChildren(); $('onboard-phone-status').textContent = v.line; renew.hidden = true; host.hidden = false; return }
    if (v.kind === 'expired') { $('onboard-phone-qr').replaceChildren(); $('onboard-phone-status').textContent = c.expired; renew.hidden = false; host.hidden = false; return }
    host.hidden = true
  }
  const flow = makePhoneLinkFlow({ ...(deps.flowDeps ?? {}), call: deps.call, onView: v => { void show(v) } })
  renew.addEventListener('click', () => { void flow.start() })
  const retry = () => { if (started && needsRetry) { needsRetry = false; void flow.start() } }
  return {
    /** @param {{ active: boolean, alive: boolean }} s */
    sync(s) {
      if (!s.active) {
        if (started) {
          started = false; needsRetry = false; seq++
          flow.stop()
          window.removeEventListener('focus', retry)
          if (timer) clearInterval(timer)
          timer = null
        }
        host.hidden = true
        return
      }
      if (s.alive && !started) {
        started = true
        window.addEventListener('focus', retry)
        timer = setInterval(retry, retryMs)
        void flow.start()
      }
    },
  }
}
