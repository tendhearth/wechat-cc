# 觅食台配对 + 派心愿确认门(桌面纯前端)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已发布的配对码(pair/start+accept)和派心愿确认门(seek propose/confirm/cancel)接进桌面觅食台页 —— 纯前端,零后端改动。

**Architecture:** 全部改动在 `apps/desktop/src/`:觅食台模块 `modules/a2a-agents.js` 增加三组 UI(心愿撰写+脱敏预览卡、proposed 行确认、配对面板),`index.html` 加静态骨架,`styles.css` 加 `fd-` 前缀样式。所有网络调用走现成 `invokeApi`(桌面 admin token 覆盖 trusted 路由;**invokeApi 在 HTTP≥400 时 throw,Error.message = 响应体的 `error` 字段**,所以 503 `social_not_wired`/`pairing_not_wired` 在 catch 里按 message 匹配)。

**Tech Stack:** 原生 JS(@ts-check JSDoc)、vitest(bare-object DOM stub,无 jsdom)、现有 `fd-` CSS 体系。

**Spec:** `docs/superpowers/specs/2026-07-22-forage-desk-pairing-seek-ui-design.md`

## Global Constraints

- **不动** `apps/desktop/src/main.js`;`initA2AAgentsTab` / `refresh` 导出签名不变。
- **零后端改动**(`src/` 下任何文件都不碰)。
- 新 CSS 类一律 `fd-` 前缀;只用已有的 pane 级 `--fd-*` 变量(`--fd-sage`、`--fd-clay-deep`、`--fd-line-soft`),**不新增/不重定义全局 token**。
- 所有插进 innerHTML 的动态值必须过模块内已有的 `escapeHtml()`。
- 事件处理器对 target 用**鸭子类型守卫**(`target?.dataset`),不用 `instanceof HTMLButtonElement` —— 测试环境是 bare-object stub(见 a2a-agents.js:365 注释)。
- 模块私有 handler 通过 `__xxxForTest` 薄再导出给测试(现有 `__onPostcardActionForTest` 模式)。
- **隐私锁:预览卡与 proposed 行只渲染 `redacted*` 字段,绝不渲染原始 `topic`**(测试断言 DOM 不含原文)。
- 保留 Playwright 依赖的既有标记:`.a2a-agent-card`、agent 列表 `.empty` 文案、`<details>` 结构不动。
- 每个任务:测试先行(先跑 FAIL 再实现),完成即 commit。
- 测试命令:`bunx vitest run apps/desktop/src/modules/a2a-agents.test.ts`(仓库根目录执行)。

---

### Task 1: 心愿撰写 → propose → 脱敏预览卡 → 确认/取消

**Files:**
- Modify: `apps/desktop/src/index.html`(§①心愿区加 compose 骨架;移除 `#fd-sow-hint`)
- Modify: `apps/desktop/src/modules/a2a-agents.js`
- Test: `apps/desktop/src/modules/a2a-agents.test.ts`

**Interfaces:**
- Consumes: `invokeApi(method, path, body?)`(throws on ≥400,message=body.error);`POST /v1/social/seek/propose {topic, city?}` → `{ok:true, intent_id, redacted, redacted_city?} | {ok:false, reason}`;`POST /v1/social/seek/confirm {id}` → `{ok:true, intent_id}|{ok:false, reason}`;`POST /v1/social/seek/cancel {id}` → `{ok:true}|{ok:false, reason}`。
- Produces: 模块私有 `onSeekAction(e)`(delegated,识别 `data-action="seek-confirm"|"seek-cancel"` + `data-id`)—— **Task 2 在 `#fd-wishes` 上复用它**;`composeErrText(err)`;测试再导出 `__onComposeSubmitForTest`、`__onSeekActionForTest`。

- [ ] **Step 1: index.html 加 compose 骨架**

在 `apps/desktop/src/index.html` §①心愿 section 里,`<div class="fd-sec-head">…</div>` 之后、`<div class="fd-wishes" id="fd-wishes"></div>` 之前插入:

```html
                  <div class="fd-compose" id="fd-compose" hidden>
                    <form id="fd-compose-form">
                      <input type="text" name="topic" id="fd-compose-topic" placeholder="想找什么？比如：找个会修老相机的师傅" maxlength="120" autocomplete="off">
                      <input type="text" name="city" id="fd-compose-city" placeholder="城市（可选）" maxlength="20" autocomplete="off">
                      <button class="fd-btn fd-btn-primary" type="submit" id="fd-compose-submit">派出去</button>
                    </form>
                    <div class="fd-compose-note" id="fd-compose-note" hidden></div>
                    <div class="fd-preview" id="fd-preview" hidden></div>
                  </div>
```

同时**删掉** hero 里的 `<div class="fd-sow-hint" id="fd-sow-hint" hidden>…</div>` 一行(index.html:602)—— 桌面现在能直接派,不再提示去微信。

- [ ] **Step 2: 写失败测试**

在 `apps/desktop/src/modules/a2a-agents.test.ts`:
1. `installDom` 的 ids 数组去掉 `'fd-sow-hint'`,加入:`'fd-compose','fd-compose-form','fd-compose-topic','fd-compose-city','fd-compose-note','fd-compose-submit','fd-preview'`。
2. 文件末尾追加:

```ts
describe('心愿 compose → propose → preview', () => {
  function composeEvent() {
    return { preventDefault() {}, target: null } as any
  }

  it('propose 成功 → 预览卡只含 redacted,原文不进 DOM', async () => {
    const el = installDom()
    el['fd-compose-topic'].value = '想找会修禄来福来的老师傅,预算两千'
    el['fd-compose-city'].value = '上海'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, intent_id: 'i1', redacted: '【求助】想找懂老相机维修的朋友', redacted_city: '上海' })
    const { __onComposeSubmitForTest } = await import('./a2a-agents.js')
    await __onComposeSubmitForTest?.(composeEvent())
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/social/seek/propose', { topic: '想找会修禄来福来的老师傅,预算两千', city: '上海' })
    const html = el['fd-preview'].innerHTML
    expect(el['fd-preview'].hidden).toBe(false)
    expect(html).toContain('外面只会看到这个')
    expect(html).toContain('【求助】想找懂老相机维修的朋友')
    expect(html).toContain('data-action="seek-confirm"')
    expect(html).toContain('data-action="seek-cancel"')
    expect(html).toContain('data-id="i1"')
    expect(html).not.toContain('禄来福来')          // 隐私锁:原文绝不渲染
  })

  it('topic 为空 → 不发请求,提示先写内容', async () => {
    const el = installDom()
    el['fd-compose-topic'].value = '   '
    ;(invokeApi as any).mockClear()
    const { __onComposeSubmitForTest } = await import('./a2a-agents.js')
    await __onComposeSubmitForTest?.(composeEvent())
    expect((invokeApi as any)).not.toHaveBeenCalled()
    expect(el['fd-compose-note'].textContent).toContain('先写下')
  })

  it('propose 返回 ok:false → reason 落 note', async () => {
    const el = installDom()
    el['fd-compose-topic'].value = '找人'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, reason: 'judge_unavailable' })
    const { __onComposeSubmitForTest } = await import('./a2a-agents.js')
    await __onComposeSubmitForTest?.(composeEvent())
    expect(el['fd-compose-note'].textContent).toContain('judge_unavailable')
  })

  it('503 social_not_wired → social enable 引导文案', async () => {
    const el = installDom()
    el['fd-compose-topic'].value = '找人'
    ;(invokeApi as any).mockRejectedValueOnce(new Error('social_not_wired'))
    const { __onComposeSubmitForTest } = await import('./a2a-agents.js')
    await __onComposeSubmitForTest?.(composeEvent())
    expect(el['fd-compose-note'].textContent).toContain('wechat-cc social enable')
  })

  it('确认派出 → POST confirm 成功后收起 compose 并清空输入', async () => {
    const el = installDom()
    el['fd-compose-topic'].value = 'x'; el['fd-compose-city'].value = 'y'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, intent_id: 'i1' })  // confirm
    ;(invokeApi as any).mockResolvedValue({})                                // refresh 级联
    const btn = fakeEl(); btn.dataset.action = 'seek-confirm'; btn.dataset.id = 'i1'
    const { __onSeekActionForTest } = await import('./a2a-agents.js')
    await __onSeekActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/social/seek/confirm', { id: 'i1' })
    expect(el['fd-compose'].hidden).toBe(true)
    expect(el['fd-compose-topic'].value).toBe('')
  })

  it('取消 → POST cancel 成功后 compose 留着可改,note 提示已取消', async () => {
    const el = installDom()
    el['fd-compose'].hidden = false
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true })
    ;(invokeApi as any).mockResolvedValue({})
    const btn = fakeEl(); btn.dataset.action = 'seek-cancel'; btn.dataset.id = 'i1'
    const { __onSeekActionForTest } = await import('./a2a-agents.js')
    await __onSeekActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/social/seek/cancel', { id: 'i1' })
    expect(el['fd-compose'].hidden).toBe(false)
    expect(el['fd-compose-note'].textContent).toContain('已取消')
  })

  it('confirm 失败(ok:false)→ note 显示原因,按钮恢复可点', async () => {
    const el = installDom()
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, reason: 'not_proposed' })
    const btn = fakeEl(); btn.dataset.action = 'seek-confirm'; btn.dataset.id = 'i1'
    const { __onSeekActionForTest } = await import('./a2a-agents.js')
    await __onSeekActionForTest?.({ target: btn } as any)
    expect(btn.disabled).toBe(false)
    expect(el['fd-compose-note'].textContent).toContain('not_proposed')
  })
})
```

注意:`fakeEl()` 返回的对象没有 `value` 字段,但它是普通对象,测试里直接赋 `el['fd-compose-topic'].value = '…'` 即可(handler 读 `input?.value ?? ''`)。

- [ ] **Step 3: 跑测试确认 FAIL**

Run: `bunx vitest run apps/desktop/src/modules/a2a-agents.test.ts`
Expected: FAIL —— `__onComposeSubmitForTest is not a function`(新 describe 全红,旧 18 个仍绿)。

- [ ] **Step 4: 实现**

`apps/desktop/src/modules/a2a-agents.js`:

4a. `initA2AAgentsTab` 里,把 hero 委托点击(a2a-agents.js:68-73)换成打开 compose:

```js
  // #fd-sow / #a2a-add-btn are re-rendered by renderForageDesk, so the sow
  // action is delegated from the hero container instead of bound to the node.
  document.getElementById('fd-hero-status')?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('#fd-sow')) {
      const compose = document.getElementById('fd-compose')
      if (compose) compose.hidden = false
      const topic = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-compose-topic'))
      if (topic && typeof topic.focus === 'function') topic.focus()
    }
  })
  document.getElementById('fd-compose-form')?.addEventListener('submit', onComposeSubmit)
  document.getElementById('fd-compose')?.addEventListener('click', onSeekAction)
```

4b. 在 `onInboundToggle` 之后新增(handler 区):

```js
// 觅愿撰写 — propose→脱敏预览→confirm/cancel。守卫同样鸭子类型(测试
// 环境是 bare-object stub)。invokeApi 对 503 会 throw Error('social_not_wired')。

/** @param {unknown} err */
function composeErrText(err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === 'social_not_wired') return '社交觅食未启用 —— 先在命令行运行 wechat-cc social enable 并重启守护进程。'
  return `派心愿失败：${msg}`
}

/** @param {SubmitEvent} e */
async function onComposeSubmit(e) {
  e.preventDefault()
  const topicInput = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-compose-topic'))
  const cityInput = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-compose-city'))
  const note = document.getElementById('fd-compose-note')
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('fd-compose-submit'))
  const topic = String(topicInput?.value ?? '').trim()
  const city = String(cityInput?.value ?? '').trim()
  if (!topic) {
    if (note) { note.hidden = false; note.textContent = '先写下你想找什么' }
    return
  }
  if (btn) btn.disabled = true
  try {
    const r = /** @type {{ok?:boolean, intent_id?:string, redacted?:string, redacted_city?:string, reason?:string}} */ (
      await invokeApi('POST', '/v1/social/seek/propose', city ? { topic, city } : { topic }))
    if (r?.ok) {
      renderProposePreview(r)
      if (note) { note.hidden = true; note.textContent = '' }
    } else {
      if (note) { note.hidden = false; note.textContent = `没能生成预览：${String(r?.reason ?? '未知错误')}` }
    }
  } catch (err) {
    if (note) { note.hidden = false; note.textContent = composeErrText(err) }
  } finally {
    if (btn) btn.disabled = false
  }
}

/**
 * 脱敏预览卡 —— 隐私锁:只渲染 redacted / redacted_city,原始 topic 绝不进 DOM。
 * @param {{intent_id?:string, redacted?:string, redacted_city?:string}} r
 */
function renderProposePreview(r) {
  const preview = document.getElementById('fd-preview')
  if (!preview) return
  const cityLine = r.redacted_city ? `<div class="fd-preview-city">📍 ${escapeHtml(r.redacted_city)}</div>` : ''
  preview.hidden = false
  preview.innerHTML = `<div class="fd-preview-card" data-intent-id="${escapeHtml(String(r.intent_id ?? ''))}">` +
    `<div class="fd-preview-eyebrow">🕶️ 外面只会看到这个</div>` +
    `<div class="fd-preview-topic">「${escapeHtml(String(r.redacted ?? ''))}」</div>` + cityLine +
    `<div class="fd-preview-actions">` +
    `<button class="fd-btn fd-btn-primary" data-action="seek-confirm" data-id="${escapeHtml(String(r.intent_id ?? ''))}">确认派出</button>` +
    `<button class="fd-btn fd-btn-wait" data-action="seek-cancel" data-id="${escapeHtml(String(r.intent_id ?? ''))}">算了，取消</button>` +
    `</div>` +
    `<div class="fd-preview-note">确认后，你的 bot 才会真的把它撒出去。</div>` +
    `</div>`
}

/** @param {boolean} confirmed */
function clearComposePreview(confirmed) {
  const preview = document.getElementById('fd-preview')
  if (preview) { preview.hidden = true; preview.innerHTML = '' }
  const note = document.getElementById('fd-compose-note')
  if (confirmed) {
    const compose = document.getElementById('fd-compose')
    const topicInput = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-compose-topic'))
    const cityInput = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-compose-city'))
    if (topicInput) topicInput.value = ''
    if (cityInput) cityInput.value = ''
    if (compose) compose.hidden = true
    if (note) { note.hidden = true; note.textContent = '' }
  } else {
    if (note) { note.hidden = false; note.textContent = '已取消 —— 想改改措辞再派也行。' }
  }
}

/**
 * Delegated:预览卡与(Task 2 起)心愿列表里 proposed 行的 确认/取消。
 * @param {MouseEvent} e
 */
async function onSeekAction(e) {
  const target = /** @type {any} */ (e.target)
  if (!target || !target.dataset) return
  const action = target.dataset.action
  const id = target.dataset.id
  if ((action !== 'seek-confirm' && action !== 'seek-cancel') || !id) return
  const note = document.getElementById('fd-compose-note')
  target.disabled = true
  try {
    const path = action === 'seek-confirm' ? '/v1/social/seek/confirm' : '/v1/social/seek/cancel'
    const r = /** @type {{ok?:boolean, reason?:string}} */ (await invokeApi('POST', path, { id }))
    if (r?.ok) {
      clearComposePreview(action === 'seek-confirm')
      await refresh().catch(() => {})
    } else {
      target.disabled = false
      if (note) { note.hidden = false; note.textContent = `${action === 'seek-confirm' ? '确认' : '取消'}失败：${String(r?.reason ?? '未知错误')}` }
    }
  } catch (err) {
    target.disabled = false
    if (note) { note.hidden = false; note.textContent = composeErrText(err) }
  }
}
```

4c. 测试再导出区(a2a-agents.js:446-447 旁)追加:

```js
export const __onComposeSubmitForTest = onComposeSubmit
export const __onSeekActionForTest = onSeekAction
```

- [ ] **Step 5: 跑测试确认 PASS**

Run: `bunx vitest run apps/desktop/src/modules/a2a-agents.test.ts`
Expected: PASS(旧 18 + 新 7)。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/index.html apps/desktop/src/modules/a2a-agents.js apps/desktop/src/modules/a2a-agents.test.ts
git commit -m "feat(desktop): 觅食台心愿撰写 propose→脱敏预览卡→确认/取消"
```

---

### Task 2: 心愿列表渲染 proposed/cancelled 行(微信提案也能桌面确认)

**Files:**
- Modify: `apps/desktop/src/modules/a2a-agents.js`
- Test: `apps/desktop/src/modules/a2a-agents.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `onSeekAction`(已识别 `data-action="seek-confirm"|"seek-cancel"`,原样复用,**本任务不改它**);`GET /v1/social/seeks` 行含 `status:'proposed'|'cancelled'` 与 `redacted_topic`/`redacted_city`(v24 列,可能为 null —— 仅限老数据)。
- Produces: `renderWish(s)` 对 `proposed`/`cancelled` 的新分支(内部函数 `renderProposedWish(s)`/`renderCancelledWish(s)`)。

- [ ] **Step 1: 写失败测试**

`a2a-agents.test.ts` 追加:

```ts
describe('renderForageDesk — proposed/cancelled 行', () => {
  const proposedSeek = { id: 'i9', kind: 'seek', topic: '原文:找禄来福来维修师傅', status: 'proposed', hop: 1, peers_asked: 0, redacted_topic: '【求助】想找懂老相机维修的朋友', redacted_city: '上海', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }

  it('proposed 行渲染 redacted_topic + 确认/取消按钮,原文不进 DOM', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [proposedSeek], echoes: [], inbound: null })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('【求助】想找懂老相机维修的朋友')
    expect(html).toContain('data-action="seek-confirm"')
    expect(html).toContain('data-action="seek-cancel"')
    expect(html).toContain('data-id="i9"')
    expect(html).toContain('外面只会看到')
    expect(html).not.toContain('禄来福来')            // 隐私锁
    expect(html).not.toContain('觅食中')              // 不是 foraging 视图
  })

  it('proposed 行缺 redacted_topic(老数据)→ 兜底文案,不渲染原文', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [{ ...proposedSeek, redacted_topic: null, redacted_city: null }], echoes: [], inbound: null })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('缺少预览文本')
    expect(html).not.toContain('禄来福来')
  })

  it('cancelled 行灰显,无操作按钮', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [{ ...proposedSeek, status: 'cancelled' }], echoes: [], inbound: null })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('fd-cancelled')
    expect(html).toContain('已取消')
    expect(html).not.toContain('data-action="seek-confirm"')
  })

  it('wishes-count 只计 foraging,不把 proposed 计成在外面', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [proposedSeek, foragingSeek], echoes: [], inbound: null })
    expect(el['fd-wishes-count'].textContent).toContain('1 条在外面')
  })
})
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `bunx vitest run apps/desktop/src/modules/a2a-agents.test.ts`
Expected: FAIL —— proposed 行按现有代码走 foraging 分支(`觅食中` 出现、按钮缺失)。

- [ ] **Step 3: 实现**

`renderWish`(a2a-agents.js:269)顶部分派 + 两个新渲染函数(放在 `renderWish` 之后):

```js
/** @param {any} s */
function renderWish(s) {
  if (s.status === 'proposed') return renderProposedWish(s)
  if (s.status === 'cancelled') return renderCancelledWish(s)
  const kindCls = s.kind === 'fun' ? 'fd-fun' : 'fd-seek'
  // …(其余原样不动)
}

/**
 * 待确认提案 —— 隐私锁:只渲染 redacted*,原始 topic 绝不进 DOM(所见即所发,
 * 展示的就是确认后会广播的字节)。redacted_topic 为 null 只可能是 P4 之前的
 * 老数据:给兜底文案,引导取消后重新发起。
 * @param {any} s
 */
function renderProposedWish(s) {
  const shown = s.redacted_topic
    ? `「${escapeHtml(s.redacted_topic)}」`
    : '（缺少预览文本 —— 取消后重新发起）'
  const cityFrag = s.redacted_city ? `<span>📍 ${escapeHtml(s.redacted_city)}</span><i class="fd-dot-sep"></i>` : ''
  return `<div class="fd-wish fd-proposed">` +
    `<span class="fd-kind fd-seek">待确认</span>` +
    `<div class="fd-title">${shown}</div>` +
    `<div class="fd-meta"><span class="fd-lock">🕶️ 外面只会看到上面这句</span><i class="fd-dot-sep"></i>${cityFrag}<span>提案于 ${escapeHtml(fdRelTime(s.created_at))}</span></div>` +
    `<div class="fd-rightcol"><div class="fd-pc-actions">` +
    `<button class="fd-btn fd-btn-primary" data-action="seek-confirm" data-id="${escapeHtml(s.id)}">确认派出</button>` +
    `<button class="fd-btn fd-btn-wait" data-action="seek-cancel" data-id="${escapeHtml(s.id)}">取消</button>` +
    `</div></div></div>`
}

/** @param {any} s — 已取消:灰显、无操作(cancelled 从未广播,本地展示原文无隐私问题)。 */
function renderCancelledWish(s) {
  return `<div class="fd-wish fd-cancelled">` +
    `<span class="fd-kind">已取消</span>` +
    `<div class="fd-title">「${escapeHtml(s.redacted_topic || s.topic || '')}」</div>` +
    `<div class="fd-meta"><span>取消于 ${escapeHtml(fdRelTime(s.updated_at || s.created_at))}</span></div>` +
    `</div>`
}
```

`initA2AAgentsTab` 里给心愿列表挂 delegated handler(和 `#fd-compose` 那行放一起):

```js
  document.getElementById('fd-wishes')?.addEventListener('click', onSeekAction)
```

(`fd-wishes-count` 的 `filter(s => s.status === 'foraging')` 现状已只计 foraging,无需改 —— 测试是防回归钉子。)

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bunx vitest run apps/desktop/src/modules/a2a-agents.test.ts`
Expected: PASS(全部)。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/modules/a2a-agents.js apps/desktop/src/modules/a2a-agents.test.ts
git commit -m "feat(desktop): 心愿列表渲染 proposed/cancelled 行 —— 微信提案可在桌面确认"
```

---

### Task 3: 觅食网区配对面板(生成码 + 输码)

**Files:**
- Modify: `apps/desktop/src/index.html`(fd-net-body 顶部加配对行)
- Modify: `apps/desktop/src/modules/a2a-agents.js`
- Test: `apps/desktop/src/modules/a2a-agents.test.ts`

**Interfaces:**
- Consumes: `POST /v1/pair/start` → `{ok:true, code, expiresAt}|{ok:false, reason:'relay_drop_failed'}`;`POST /v1/pair/accept {code}` → `{ok:true, peer:{self_id, name}}|{ok:false, reason:'expired_or_wrong'|'self_pair'|'id_conflict'|'relay_drop_failed'}`;503 → throw `Error('pairing_not_wired')`;`GET /v1/a2a/list` → `{agents:[{id,name,…}]}`。
- Produces: 测试再导出 `__onPairStartForTest`、`__onPairAcceptForTest`、`__checkPairLandedForTest`、`__stopPairTimersForTest`。

- [ ] **Step 1: index.html 加配对骨架**

`apps/desktop/src/index.html` 的 `<div class="fd-net-body">` 内、现有第一个 `.fd-net-row`(inbound toggle 行)**之前**插入:

```html
                      <div class="fd-net-row fd-net-row-pair">
                        <div class="fd-txt"><div class="fd-t">和朋友配对</div><div class="fd-s">一个人生成 6 位码念给对方，另一个人输入 —— 两只 bot 就成了邻居</div></div>
                        <button class="fd-btn fd-btn-primary" id="fd-pair-start" type="button">生成配对码</button>
                      </div>
                      <div class="fd-pair-panel" id="fd-pair-panel" hidden></div>
                      <div class="fd-net-row fd-net-row-pair-accept">
                        <input class="fd-pair-input" id="fd-pair-code" inputmode="numeric" maxlength="6" placeholder="输入朋友的 6 位码" autocomplete="off">
                        <button class="fd-btn" id="fd-pair-accept" type="button">配对</button>
                      </div>
                      <div class="fd-inbound-note" id="fd-pair-note" hidden></div>
```

- [ ] **Step 2: 写失败测试**

`installDom` 的 ids 数组追加:`'fd-pair-start','fd-pair-accept','fd-pair-code','fd-pair-panel','fd-pair-note','fd-pair-countdown'`。

注意 `renderPairPanel` 会把 `#fd-pair-countdown` 写进 `#fd-pair-panel` 的 innerHTML —— stub DOM 靠 `installDom` 预置同名 id 元素让 `updatePairCountdown` 找得到,足够断言。

```ts
describe('配对面板', () => {
  it('start 成功 → 面板显示 6 位码 + 倒计时文本', async () => {
    const el = installDom()
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [{ id: 'old', name: '旧友' }] })  // 快照
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, code: '277499', expiresAt: Date.now() + 600_000 })
    const { __onPairStartForTest, __stopPairTimersForTest } = await import('./a2a-agents.js')
    await __onPairStartForTest?.()
    __stopPairTimersForTest?.()
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/pair/start')
    expect(el['fd-pair-panel'].hidden).toBe(false)
    expect(el['fd-pair-panel'].innerHTML).toContain('277499')
    expect(el['fd-pair-panel'].innerHTML).toContain('wechat-cc pair 277499')
    expect(el['fd-pair-countdown'].textContent).toContain('有效期还剩')
  })

  it('start relay_drop_failed → 中继文案', async () => {
    const el = installDom()
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [] })
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, reason: 'relay_drop_failed' })
    const { __onPairStartForTest } = await import('./a2a-agents.js')
    await __onPairStartForTest?.()
    expect(el['fd-pair-note'].textContent).toContain('中继')
  })

  it('start 503 pairing_not_wired → social enable 引导', async () => {
    const el = installDom()
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [] })
    ;(invokeApi as any).mockRejectedValueOnce(new Error('pairing_not_wired'))
    const { __onPairStartForTest } = await import('./a2a-agents.js')
    await __onPairStartForTest?.()
    expect(el['fd-pair-note'].textContent).toContain('wechat-cc social enable')
  })

  it('accept 本地校验:非 6 位数字不发请求', async () => {
    const el = installDom()
    el['fd-pair-code'].value = '12ab3'
    ;(invokeApi as any).mockClear()
    const { __onPairAcceptForTest } = await import('./a2a-agents.js')
    await __onPairAcceptForTest?.()
    expect((invokeApi as any)).not.toHaveBeenCalled()
    expect(el['fd-pair-note'].textContent).toContain('6 位数字')
  })

  it('accept 成功 → 显示对方名字并清空输入', async () => {
    const el = installDom()
    el['fd-pair-code'].value = '277499'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, peer: { self_id: 'cc-b', name: '老王的CC' } })
    ;(invokeApi as any).mockResolvedValue({})   // refresh 级联
    const { __onPairAcceptForTest } = await import('./a2a-agents.js')
    await __onPairAcceptForTest?.()
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/pair/accept', { code: '277499' })
    expect(el['fd-pair-note'].textContent).toContain('老王的CC')
    expect(el['fd-pair-code'].value).toBe('')
  })

  it.each([
    ['expired_or_wrong', '码不对或已过期'],
    ['self_pair', '不能和自己'],
    ['id_conflict', '冲突'],
    ['relay_drop_failed', '中继'],
  ])('accept 失败 %s → 人话文案', async (reason, copy) => {
    const el = installDom()
    el['fd-pair-code'].value = '111111'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, reason })
    const { __onPairAcceptForTest } = await import('./a2a-agents.js')
    await __onPairAcceptForTest?.()
    expect(el['fd-pair-note'].textContent).toContain(copy)
  })

  it('checkPairLanded 发现新 agent → 配对成功文案 + 收起面板', async () => {
    const el = installDom()
    el['fd-pair-panel'].hidden = false
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [{ id: 'old' }, { id: 'fresh', name: '小李的CC' }] })
    ;(invokeApi as any).mockResolvedValue({})   // refresh 级联
    const { __checkPairLandedForTest } = await import('./a2a-agents.js')
    await __checkPairLandedForTest?.(new Set(['old']))
    expect(el['fd-pair-note'].textContent).toContain('小李的CC')
    expect(el['fd-pair-panel'].hidden).toBe(true)
  })
})
```

- [ ] **Step 3: 跑测试确认 FAIL**

Run: `bunx vitest run apps/desktop/src/modules/a2a-agents.test.ts`
Expected: FAIL —— `__onPairStartForTest is not a function`。

- [ ] **Step 4: 实现**

`a2a-agents.js` handler 区追加(`onSeekAction` 之后):

```js
// 配对码 — start(生成 6 位码,完成靠后端轮询引擎异步收边)+ accept(同步出结果)。
// 码展示期间每 15s 拉一次 agent 列表,出现新条目即判定配对完成。

/** @type {ReturnType<typeof setInterval> | null} */
let pairCountdownTimer = null
/** @type {ReturnType<typeof setInterval> | null} */
let pairPollTimer = null

const PAIR_FAIL_COPY = /** @type {Record<string, string>} */ ({
  expired_or_wrong: '码不对或已过期 —— 让朋友重新生成一个试试',
  self_pair: '这是你自己的码，不能和自己配对',
  id_conflict: '对方的名字和你已有的朋友冲突 —— 让对方改名后重试',
  relay_drop_failed: '中继暂时联系不上，稍后再试',
})

/** @param {unknown} err */
function pairErrText(err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === 'pairing_not_wired') return '配对功能未启用 —— 先在命令行运行 wechat-cc social enable 并重启守护进程。'
  return `配对失败：${msg}`
}

function stopPairTimers() {
  if (pairCountdownTimer) { clearInterval(pairCountdownTimer); pairCountdownTimer = null }
  if (pairPollTimer) { clearInterval(pairPollTimer); pairPollTimer = null }
}

async function onPairStart() {
  const note = document.getElementById('fd-pair-note')
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('fd-pair-start'))
  stopPairTimers()
  if (note) { note.hidden = true; note.textContent = '' }
  if (btn) btn.disabled = true
  try {
    // 先快照现有 agent id,轮询时用差集判断新边落地。
    const before = /** @type {{agents?:Array<any>}|null} */ (await invokeApi('GET', '/v1/a2a/list').catch(() => null))
    const knownIds = new Set((before?.agents ?? []).map(a => String(a.id)))
    const r = /** @type {{ok?:boolean, code?:string, expiresAt?:number, reason?:string}} */ (
      await invokeApi('POST', '/v1/pair/start'))
    if (!r?.ok) {
      if (note) { note.hidden = false; note.textContent = PAIR_FAIL_COPY[String(r?.reason)] ?? `配对失败：${String(r?.reason ?? '未知错误')}` }
      return
    }
    renderPairPanel(String(r.code ?? ''), Number(r.expiresAt) || 0)
    pairCountdownTimer = setInterval(() => updatePairCountdown(Number(r.expiresAt) || 0), 1000)
    pairPollTimer = setInterval(() => { checkPairLanded(knownIds).catch(() => {}) }, 15_000)
  } catch (err) {
    if (note) { note.hidden = false; note.textContent = pairErrText(err) }
  } finally {
    if (btn) btn.disabled = false
  }
}

/** @param {string} code  @param {number} expiresAt */
function renderPairPanel(code, expiresAt) {
  const panel = document.getElementById('fd-pair-panel')
  if (!panel) return
  panel.hidden = false
  panel.innerHTML = `<div class="fd-pair-code">${escapeHtml(code)}</div>` +
    `<div class="fd-pair-cap">念给朋友 —— 对方在他的觅食台输入，或运行 <code>wechat-cc pair ${escapeHtml(code)}</code></div>` +
    `<div class="fd-pair-count" id="fd-pair-countdown"></div>`
  updatePairCountdown(expiresAt)
}

/** @param {number} expiresAt */
function updatePairCountdown(expiresAt) {
  const left = Math.floor((expiresAt - Date.now()) / 1000)
  if (left <= 0) {
    stopPairTimers()
    const panel = document.getElementById('fd-pair-panel')
    if (panel) { panel.hidden = true; panel.innerHTML = '' }
    const note = document.getElementById('fd-pair-note')
    if (note) { note.hidden = false; note.textContent = '配对码已过期 —— 需要时再生成一个。' }
    return
  }
  const el = document.getElementById('fd-pair-countdown')
  if (el) el.textContent = `有效期还剩 ${Math.floor(left / 60)} 分 ${left % 60} 秒`
}

/**
 * 轮询判定:agent 列表出现快照之外的新 id ⇒ 对方接受了码,配对完成。
 * @param {Set<string>} knownIds
 */
async function checkPairLanded(knownIds) {
  const r = /** @type {{agents?:Array<any>}|null} */ (await invokeApi('GET', '/v1/a2a/list').catch(() => null))
  const fresh = (r?.agents ?? []).find(a => !knownIds.has(String(a.id)))
  if (!fresh) return
  stopPairTimers()
  const panel = document.getElementById('fd-pair-panel')
  if (panel) { panel.hidden = true; panel.innerHTML = '' }
  const note = document.getElementById('fd-pair-note')
  if (note) { note.hidden = false; note.textContent = `🎉 配对成功：已和 ${fresh.name || fresh.id} 成为邻居` }
  refresh().catch(() => {})
}

async function onPairAccept() {
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-pair-code'))
  const note = document.getElementById('fd-pair-note')
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('fd-pair-accept'))
  const code = String(input?.value ?? '').trim()
  if (!/^\d{6}$/.test(code)) {
    if (note) { note.hidden = false; note.textContent = '配对码是 6 位数字' }
    return
  }
  if (btn) { btn.disabled = true; btn.textContent = '配对中…' }
  try {
    const r = /** @type {{ok?:boolean, peer?:{self_id?:string, name?:string}, reason?:string}} */ (
      await invokeApi('POST', '/v1/pair/accept', { code }))
    if (r?.ok) {
      if (note) { note.hidden = false; note.textContent = `🎉 已和 ${r.peer?.name ?? r.peer?.self_id ?? '对方'} 成为邻居` }
      if (input) input.value = ''
      refresh().catch(() => {})
    } else {
      if (note) { note.hidden = false; note.textContent = PAIR_FAIL_COPY[String(r?.reason)] ?? `配对失败：${String(r?.reason ?? '未知错误')}` }
    }
  } catch (err) {
    if (note) { note.hidden = false; note.textContent = pairErrText(err) }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '配对' }
  }
}
```

`initA2AAgentsTab` 追加接线(和其他 fd 接线放一起):

```js
  document.getElementById('fd-pair-start')?.addEventListener('click', onPairStart)
  document.getElementById('fd-pair-accept')?.addEventListener('click', onPairAccept)
```

测试再导出区追加:

```js
export const __onPairStartForTest = onPairStart
export const __onPairAcceptForTest = onPairAccept
export const __checkPairLandedForTest = checkPairLanded
export const __stopPairTimersForTest = stopPairTimers
```

- [ ] **Step 5: 跑测试确认 PASS**

Run: `bunx vitest run apps/desktop/src/modules/a2a-agents.test.ts`
Expected: PASS(全部,含 it.each 展开)。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/index.html apps/desktop/src/modules/a2a-agents.js apps/desktop/src/modules/a2a-agents.test.ts
git commit -m "feat(desktop): 觅食网配对面板 —— 生成 6 位码 + 输码接受,完成靠列表轮询判定"
```

---

### Task 4: CSS(compose/预览卡/proposed 行/配对面板)+ 全量回归

**Files:**
- Modify: `apps/desktop/src/styles.css`(fd 段末尾追加)

**Interfaces:**
- Consumes: Task 1-3 产出的类名:`fd-compose`、`fd-compose-note`、`fd-preview`、`fd-preview-card`、`fd-preview-eyebrow`、`fd-preview-topic`、`fd-preview-city`、`fd-preview-actions`、`fd-preview-note`、`fd-wish.fd-proposed`、`fd-wish.fd-cancelled`、`fd-net-row-pair`、`fd-net-row-pair-accept`、`fd-pair-input`、`fd-pair-panel`、`fd-pair-code`、`fd-pair-cap`、`fd-pair-count`。
- Produces: 无(纯样式收口)。

- [ ] **Step 1: styles.css 追加样式**

在 `apps/desktop/src/styles.css` 的 fd 样式段末尾(`.fd-toggle` 那一片之后)追加:

```css
/* ── 觅食台:心愿撰写 + 脱敏预览卡 ─────────────────────────────── */
.fd-compose { margin: 0 0 14px; }
.fd-compose form { display: flex; gap: 8px; flex-wrap: wrap; }
.fd-compose input { flex: 1 1 220px; padding: 9px 12px; border: 1px solid var(--fd-line-soft); border-radius: 10px; background: transparent; font: inherit; color: inherit; }
.fd-compose #fd-compose-city { flex: 0 1 140px; }
.fd-compose-note { margin-top: 8px; font-size: 12.5px; color: var(--fd-clay-deep); }
.fd-preview { margin-top: 10px; }
.fd-preview-card { border: 1.5px dashed var(--fd-sage); border-radius: 12px; padding: 12px 14px; }
.fd-preview-eyebrow { font-size: 12px; opacity: .75; margin-bottom: 6px; }
.fd-preview-topic { font-weight: 600; margin-bottom: 4px; }
.fd-preview-city { font-size: 12.5px; opacity: .8; margin-bottom: 6px; }
.fd-preview-actions { display: flex; gap: 8px; margin: 8px 0 4px; }
.fd-preview-note { font-size: 12px; opacity: .7; }
/* proposed / cancelled 心愿行 */
.fd-wish.fd-proposed { border-style: dashed; }
.fd-wish.fd-cancelled { opacity: .55; }
/* ── 觅食网:配对 ─────────────────────────────────────────────── */
.fd-net-row-pair-accept { gap: 8px; }
.fd-pair-input { flex: 1 1 160px; padding: 9px 12px; border: 1px solid var(--fd-line-soft); border-radius: 10px; font: inherit; color: inherit; background: transparent; letter-spacing: .2em; }
.fd-pair-panel { padding: 12px 0; text-align: center; }
.fd-pair-code { font-size: 34px; font-weight: 700; letter-spacing: .35em; color: var(--fd-clay-deep); }
.fd-pair-cap { font-size: 12.5px; opacity: .8; margin-top: 4px; }
.fd-pair-count { font-size: 12px; opacity: .7; margin-top: 4px; }
```

- [ ] **Step 2: 全量回归**

Run(仓库根目录): `bun run test`
Expected: 全绿(桌面模块测试 + 后端全套;本分支未动后端,任何后端红都是环境问题,先查再动)。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/styles.css
git commit -m "style(desktop): 觅食台 compose/预览卡/proposed 行/配对面板样式"
```

---

## Self-Review 结论(已跑)

- **Spec 覆盖**:§①compose+预览+确认/取消=Task 1;§①列表联动 proposed/cancelled=Task 2;§②配对(start/accept/倒计时/轮询/文案映射)=Task 3;§③错误处理分散进 Task 1(`social_not_wired`)与 Task 3(`pairing_not_wired`+按钮防双击+定时器清理);测试要求逐条对应;CSS=Task 4。无缺口。
- **占位符**:无 TBD/TODO;所有步骤含完整代码。
- **类型/命名一致性**:`onSeekAction` 在 Task 1 定义、Task 2 只挂接线不改;`data-action="seek-confirm"|"seek-cancel"` 两任务一致;`__xxxForTest` 命名与现有模式一致;`PAIR_FAIL_COPY` 键与 `PairResult.reason` 联合完全对齐。
