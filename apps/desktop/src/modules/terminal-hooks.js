// @ts-check
// terminal-hooks.js — 「接上终端里的 Claude Code / Codex」(2026-10-14)。
//
// 终端会话只经 hooks 才到得了 CC。「CC 现在怎么样」那一行(daemon capabilities.ts,action.run =
// cli_hooks_install)和引导页最后一步都用这里的同一个按钮:点了先说一句会改什么、能撤掉,
// 主人再点「确定」才 POST /v1/cli/hooks/install —— 明确点了才算同意,绝不自动装。

export const HOOKS_RUN = 'cli_hooks_install'
const READ_TRIES = 3
export const HOOKS_INSTALL_PATH = '/v1/cli/hooks/install'
// 确认只说一句(原因上一行已经说过);改哪几个文件、怎么撤,收在「详细」里(2026-10-16)。
export const HOOKS_CONFIRM = '只加 CC 自己的几条 hook，随时能撤掉。'
export const HOOKS_DETAIL = '改的是 Claude Code 的 ~/.claude/settings.json 和 Codex 的 hooks.json，别的设置不碰。想撤掉：在终端运行 wechat-cc hook uninstall。'

/** @typedef {(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<unknown>} Call */
/** @typedef {{ phase: 'idle' | 'confirm' | 'busy' | 'error', error?: string }} HooksUi */

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}
/** @param {string} cls @param {string} text @param {() => void} onClick */
function btn(cls, text, onClick) {
  const b = /** @type {HTMLButtonElement} */ (el('button', cls, text))
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

/**
 * 跑一次接上。路由回 ok:false(某一家的配置读不了等)⇒ 带上第一条错误;网络 / 宿主错误同样不抛。
 * @param {Call} call
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function runHooksInstall(call) {
  try {
    const r = /** @type {{ ok?: boolean, results?: Array<{ ok?: boolean, error?: string, skipped?: string }> } | null} */ (await call('POST', HOOKS_INSTALL_PATH, {}))
    if (r && r.ok === false) {
      const bad = (r.results ?? []).find(x => x.ok === false)
      return { ok: false, error: bad?.error ?? (bad?.skipped === 'cli_not_found' ? '这台电脑上没找到这个 CLI' : '没接上') }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 一个带确认的按钮。状态留在控制器里:外层整块重画(连接浮层每 30 秒刷新一次)也不会把「确认中」冲掉。
 * @param {{ call: Call, rerender: () => void, onDone: () => void }} o
 */
export function makeHooksAction(o) {
  /** @type {HooksUi} */ let ui = { phase: 'idle' }
  const set = (/** @type {HooksUi} */ next) => { ui = next; o.rerender() }
  async function confirmInstall() {
    if (ui.phase === 'busy') return
    set({ phase: 'busy' })
    const r = await runHooksInstall(o.call)
    if (r.ok) { ui = { phase: 'idle' }; o.onDone(); return }
    set({ phase: 'error', error: r.error })
  }
  return {
    get state() { return ui },
    /**
     * 当前状态下的节点(按钮 / 确认一句 + 确定 / 取消 / 正在接上 / 出错 + 再试)。
     * @param {string} label 「接上」或「修复」
     * @returns {HTMLElement}
     */
    node(label) {
      const box = el('div', 'hooks-action')
      box.dataset.phase = ui.phase
      if (ui.phase === 'idle') box.append(btn('nc-action', label, () => set({ phase: 'confirm' })))
      else if (ui.phase === 'confirm') {
        const row = el('div', 'hooks-buttons')
        row.append(btn('nc-action hooks-confirm-yes', `确定${label}`, () => { void confirmInstall() }), btn('nc-action hooks-confirm-no', '取消', () => set({ phase: 'idle' })))
        const more = el('details', 'hooks-detail')
        more.append(el('summary', '', '详细'), el('p', '', HOOKS_DETAIL))
        box.append(el('p', 'hooks-confirm', HOOKS_CONFIRM), more, row)
      } else if (ui.phase === 'busy') box.append(el('p', 'hooks-status', '正在接上…'))
      else {
        box.append(el('p', 'hooks-error', `没接上：${ui.error ?? ''}`), btn('nc-action', `再${label}一次`, () => set({ phase: 'confirm' })))
      }
      return box
    },
  }
}

/**
 * 引导页最后一步(#screen-service)的可选一块:daemon 活着且这台机上有没接上的 Claude Code / Codex 才出现,
 * 永不挡「开始使用」。数据与「CC 现在怎么样」同源(GET /v1/connections 里 id=terminal 那一行)。
 * @param {{ host: HTMLElement, call: Call }} deps
 */
export function mountOnboardTerminal(deps) {
  const { host } = deps
  host.hidden = true
  let started = false
  let seq = 0
  /** @type {{ name: string, reason: string, label: string } | null} */ let row = null
  let done = false
  let failures = 0
  const action = makeHooksAction({ call: deps.call, rerender: () => render(), onDone: () => { done = true; render() } })
  function render() {
    if (!started || (!row && !done)) { host.hidden = true; return }
    /** @type {HTMLElement[]} */
    const parts = [el('h3', 'onboard-terminal-title', '也接上终端里的会话（可选）')]
    if (done) parts.push(el('p', 'onboard-terminal-note', '接上了。之后终端里的会话做完、等你批准，CC 都会告诉你。'))
    else if (row) parts.push(el('p', 'onboard-terminal-note', row.reason), action.node(row.label))
    host.replaceChildren(...parts)
    host.hidden = false
  }
  async function load() {
    const mine = ++seq
    try {
      const r = /** @type {{ capabilities?: Array<{ id: string, name: string, reason: string, state: string, action?: { label: string, run?: string } }> } | null} */ (await deps.call('GET', '/v1/connections'))
      if (mine !== seq || !started) return
      const cap = (r?.capabilities ?? []).find(c => c.id === 'terminal')
      row = cap?.action?.run === HOOKS_RUN ? { name: cap.name, reason: cap.reason, label: cap.action.label } : null
    } catch {
      if (mine !== seq) return
      row = null
      // daemon 刚起来时可能还读不到:下一次 sync(doctor 轮询)再问,最多 READ_TRIES 次。
      if (++failures < READ_TRIES) { started = false; host.hidden = true; return }
    }
    render()
  }
  return {
    /** @param {{ active: boolean, alive: boolean }} s */
    sync(s) {
      if (!s.active) { if (started) { started = false; seq++ } host.hidden = true; return }
      if (s.alive && !started) { started = true; void load() }
    },
  }
}
