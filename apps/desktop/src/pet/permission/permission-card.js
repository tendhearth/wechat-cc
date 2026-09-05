// @ts-check
// permission-card.js — 桌面这一侧的权限卡片(spec §6:一个权限,两个呈现面)。
//
// 只认语义:给它「最早那条待决权限 + 一共几条」,它负责画、负责收。
// - 同一 hash 反复 show 不重建 —— 轮询每 2 秒来一拍,重建会把焦点从按钮上打掉。
// - 没有 admin 档凭据(浏览器预览:没有 Tauri 运行时)时不出按钮,只留一行
//   「微信里有一条等你确认」;真要点的人去微信点,别给一个按下去必然 403 的按钮。
// - 全部节点走注入的 makeEl,不用 innerHTML(prompt 是不可信文本)。

/** @typedef {{ hash: string, prompt: string, since: string, expires_at: string }} PermissionItem */

const TITLE = '这个要你看一下'
const FAIL_NOTE = ' 没送出去,再试一次'

/**
 * onResolve 的三种结局(spec §6):
 *  - 'resolved' 真的拍板了 → 收卡片;
 *  - 'gone'     请求通了,但这条已经不在了(微信那端刚点过 / 过期)→ 也收卡片,
 *               这不是失败,说「没送出去」是撒谎;下一拍列表自会同步;
 *  - 'failed'   请求本身没成(没凭据 / 超时 / 403)→ 恢复按钮 + 提示重试。
 * @typedef {'resolved' | 'gone' | 'failed'} ResolveOutcome
 *
 * @param {{ el: any, makeEl: (tag: string) => any }} root
 * @param {{ canResolve: boolean, onResolve: (hash: string, decision: 'allow' | 'deny') => Promise<ResolveOutcome> }} opts
 */
export function createPermissionCard(root, { canResolve, onResolve }) {
  const el = root.el
  /** @param {string} tag @param {string} cls @param {string} [text] */
  const make = (tag, cls, text) => {
    const node = root.makeEl(tag)
    node.classList.add(cls)
    if (text !== undefined) node.textContent = text
    return node
  }

  /** @type {string | null} */
  let hash = null
  /** @type {any} */ let title = null
  /** @type {any} */ let count = null
  /** @type {any} */ let pre = null
  /** @type {any} */ let view = null
  /** @type {any} */ let allow = null
  /** @type {any} */ let deny = null

  // 标题里还挂着计数 span:真 DOM 里改 textContent 会把子节点清掉,所以改完再挂回去。
  /** @param {string} text */
  const setTitle = (text) => { if (!title) return; title.textContent = text; if (count) title.appendChild(count) }
  /** @param {number} n */
  const setCount = (n) => { if (!count) return; const extra = Math.max(0, (n | 0) - 1); count.textContent = `+${extra}`; count.hidden = extra <= 0 }
  /** @param {boolean} open */
  const setExpanded = (open) => { if (!pre || !view) return; pre.hidden = !open; view.setAttribute('aria-expanded', open ? 'true' : 'false') }

  function hide() {
    hash = null
    title = count = pre = view = allow = deny = null
    el.replaceChildren()
    el.hidden = true
  }

  /**
   * @param {'allow' | 'deny'} decision
   */
  async function decide(decision) {
    if (!hash) return
    const target = hash
    if (allow) allow.disabled = true
    if (deny) deny.disabled = true
    /** @type {ResolveOutcome} */
    let outcome = 'failed'
    try { outcome = await onResolve(target, decision) } catch { outcome = 'failed' }
    // resolved 与 gone 都意味着「这条不用你再管了」——只有 failed 才留提示。
    if (outcome !== 'failed') { hide(); return }
    // 等待期间卡片可能已经换了一条(另一端 resolve 掉了这条)—— 那就别去动新卡片。
    if (hash !== target) return
    if (allow) allow.disabled = false
    if (deny) deny.disabled = false
    setTitle(TITLE + FAIL_NOTE)
  }

  /** @param {PermissionItem} item */
  function build(item) {
    const card = make('div', 'pet-card')
    card.setAttribute('role', 'group')
    card.setAttribute('aria-label', '需要你看一下')

    title = make('p', 'pet-card-title')
    count = make('span', 'pet-card-count')
    count.hidden = true
    card.appendChild(title)
    setTitle(TITLE)

    if (canResolve) {
      pre = make('pre', 'pet-card-prompt', item.prompt ?? '')
      pre.hidden = true
      card.appendChild(pre)

      const actions = make('div', 'pet-card-actions')
      allow = make('button', 'pet-card-allow', '允许')
      allow.setAttribute('type', 'button')
      allow.addEventListener('click', () => { decide('allow') })
      deny = make('button', 'pet-card-deny', '拒绝')
      deny.setAttribute('type', 'button')
      deny.addEventListener('click', () => { decide('deny') })
      view = make('button', 'pet-card-view', '查看')
      view.setAttribute('type', 'button')
      view.setAttribute('aria-expanded', 'false')
      view.addEventListener('click', () => { setExpanded(!!pre && pre.hidden) })
      actions.appendChild(allow)
      actions.appendChild(deny)
      actions.appendChild(view)
      card.appendChild(actions)
    } else {
      card.appendChild(make('p', 'pet-card-note', '微信里有一条等你确认'))
    }

    el.replaceChildren(card)
  }

  // Esc 先收起展开的 prompt(而不是关窗)——只有真展开着时才拦这一下。
  el.addEventListener('keydown', (/** @type {any} */ event) => {
    if (!event || event.key !== 'Escape') return
    if (!pre || pre.hidden) return
    event.preventDefault?.()
    event.stopPropagation?.()
    setExpanded(false)
  })

  return {
    /** @param {PermissionItem} item @param {number} n */
    show(item, n) {
      if (!item || !item.hash) { hide(); return }
      if (hash === item.hash) { setCount(n); el.hidden = false; return }
      hash = item.hash
      build(item)
      setCount(n)
      el.hidden = false
      // 只在第一次露出这条时抢焦点:同 hash 的下一拍再 focus 会打断用户的 Tab。
      allow?.focus?.()
    },
    hide() { if (hash === null && el.hidden) return; hide() },
    current() { return hash },
  }
}
