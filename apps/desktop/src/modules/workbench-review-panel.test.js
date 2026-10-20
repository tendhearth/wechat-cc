import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { renderReviewPanel, reviewSummary, reviewsSignature } from './workbench-review-panel.js'
import { createReviewDiffBudget, renderReviewFileDiff } from './workbench-code-review.js'

/** @param {string} value */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
const formatTime = (/** @type {number} */ value) => `T${value}`
const renderDiff = (/** @type {{diff?:string}} */ file) => file.diff ? `<pre class="wb-review-diff"><code>${escapeHtml(file.diff)}</code></pre>` : ''
const options = (/** @type {Record<string,unknown>} */ extra = {}) => ({ escapeHtml, formatTime, renderDiff, ...extra })

const file = (/** @type {Record<string,unknown>} */ overrides = {}) => ({ path: 'src/app.ts', preexisting: false, kind: 'modified', diff: '@@ -1 +1 @@\n-old\n+new', ...overrides })
const turn = (/** @type {Record<string,unknown>} */ overrides = {}) => ({
  artifactId: 'ART-1', sha256: 'a'.repeat(64), name: '本轮文件对比.json', createdAt: 100,
  status: 'complete', headBefore: null, headAfter: null, preexistingPaths: [], notes: [], files: [file()], ...overrides,
})

describe('改动面板', () => {
  it('按回合汇总轮数、文件数与标记数', () => {
    const reviews = [
      turn({ artifactId: 'ART-2', sha256: 'b'.repeat(64), files: [file({ path: 'a.ts', mark: { mark: 'accepted', comment: '', createdAt: 5 } }), file({ path: 'b.ts' })] }),
      turn({ files: [file({ path: 'c.ts', mark: { mark: 'returned', comment: '再改一版', createdAt: 4 } })] }),
    ]
    expect(reviewSummary(reviews)).toEqual({ turns: 2, files: 3, accepted: 1, returned: 1 })
    const html = renderReviewPanel(reviews, options())
    expect(html).toContain('2 轮 · 3 个文件 · 已接受 1 · 已打回 1')
    expect(html).toContain('id="wb-review"')
    expect(html).toContain('data-review-disclosure')
    // 新的一轮排在最前面,轮次号从最早的一轮往后数。
    expect(html.indexOf('第 2 轮')).toBeLessThan(html.indexOf('第 1 轮'))
    expect(html).toContain('已接受')
    expect(html).toContain('已打回')
    expect(html).toContain('再改一版')
    expect(reviewSummary([])).toEqual({ turns: 0, files: 0, accepted: 0, returned: 0 })
    expect(renderReviewPanel([], options())).toBe('')
  })

  it('有风险的文件标「注意 · 原因」(B6),普通文件不标', () => {
    const html = renderReviewPanel([turn({ files: [file({ path: 'src/auth/session.ts', risk: ['鉴权 / 权限'] }), file({ path: 'src/ui.ts' })] })], options())
    expect(html).toContain('<span class="wb-review-risk">注意 · 鉴权 / 权限</span>')
    expect(html.match(/wb-review-risk/g)).toHaveLength(1)
  })

  it('逐文件展开 diff:种类徽章、开始时已有修改、稳定的展开 id', () => {
    const html = renderReviewPanel([turn({ preexistingPaths: ['src/app.ts'], notes: ['读取数量超过限制'], files: [file({ preexisting: true, kind: 'added' })] })], options())
    expect(html).toContain('新增')
    expect(html).toContain('开始时已有修改')
    expect(html).toContain('读取数量超过限制')
    expect(html).toContain(`id="wb-review-${'a'.repeat(8)}-0"`)
    expect(html).toContain('data-review-file-path="src/app.ts"')
    expect(html).toContain('<pre class="wb-review-diff">')
    expect(html).toContain('data-review-turn="' + 'a'.repeat(64) + '"')
    expect(html).toContain('T100')
  })

  it('未展开的文件不给按钮;已接受的文件按钮变「已接受」且仍可打回', () => {
    const skipped = renderReviewPanel([turn({ files: [file({ path: 'big.bin', kind: 'not_reviewed', diff: undefined, reason: '二进制文件未展开' })] })], options())
    expect(skipped).toContain('未展开')
    expect(skipped).toContain('二进制文件未展开')
    expect(skipped).not.toContain('data-action="review-accept"')
    expect(skipped).not.toContain('data-action="review-return"')
    const accepted = renderReviewPanel([turn({ files: [file({ mark: { mark: 'accepted', comment: '', createdAt: 5 } })] })], options())
    expect(accepted).toContain('data-action="review-accept"')
    expect(accepted).toContain('data-action="review-return"')
    expect(accepted).toMatch(/data-action="review-accept"[^>]*>已接受</)
    expect(accepted).toContain('data-artifact-id="ART-1"')
    expect(accepted).toContain('data-path="src/app.ts"')
  })

  it('打回表单只在被点开的那一轮出现,勾选与草稿都留住', () => {
    const reviews = [turn(), turn({ artifactId: 'ART-2', sha256: 'b'.repeat(64), files: [file({ path: 'x.ts' }), file({ path: 'y.ts', kind: 'not_reviewed', diff: undefined })] })]
    expect(renderReviewPanel(reviews, options())).not.toContain('review-return-submit')
    const html = renderReviewPanel(reviews, options({ returnOpen: { artifactId: 'ART-2', paths: ['x.ts'], comment: '把命名改回来' } }))
    expect(html).toContain('<form class="wb-review-return-form" data-action="review-return-submit" data-artifact-id="ART-2">')
    expect(html).toContain('name="paths" value="x.ts" checked')
    // 未展开的文件不能打回,所以也不出现在勾选列表里。
    expect(html).not.toContain('value="y.ts"')
    expect(html).toContain('把命名改回来')
    expect(html).toContain('data-action="review-return-cancel"')
    expect(html.match(/review-return-submit/g)).toHaveLength(1)
  })

  it('读不到改动记录时照实说,不把空当成没改动', () => {
    const html = renderReviewPanel([], options({ error: true }))
    expect(html).toContain('改动记录暂时读不到')
    expect(html).toContain('id="wb-review"')
    expect(renderReviewPanel([turn()], options({ error: true }))).toContain('改动记录暂时读不到')
  })

  it('路径、意见、说明一律转义', () => {
    const html = renderReviewPanel([turn({
      artifactId: '"><img src=x>', notes: ['<script>note()</script>'],
      files: [file({ path: '"><script>path()</script>', reason: '<iframe src=javascript:bad>', mark: { mark: 'returned', comment: '<img src=x onerror=alert(1)>', createdAt: 1 } })],
    })], options({ returnOpen: { artifactId: '"><img src=x>', paths: ['"><script>path()</script>'], comment: '</textarea><script>draft()</script>' } }))
    expect(html).toContain('&lt;script&gt;path()&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;/textarea&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img ')
    expect(html).not.toContain('<iframe ')
  })

  it('只有最近三轮就地展开 diff,更早的一轮指回「成果」', () => {
    const reviews = Array.from({ length: 5 }, (_, index) => turn({ artifactId: `ART-${index}`, sha256: String(index).repeat(8) + 'a'.repeat(56) }))
    const html = renderReviewPanel(reviews, options())
    expect(new Set(html.match(/id="wb-review-[^"]+"/g)).size).toBe(5)
    const sections = html.split('<section class="wb-review-turn"').slice(1)
    expect(sections).toHaveLength(5)
    for (const inline of sections.slice(0, 3)) {
      expect(inline).toContain('<pre class="wb-review-diff">')
      expect(inline).not.toContain('较早的一轮')
    }
    for (const older of sections.slice(3)) {
      expect(older).not.toContain('<pre class="wb-review-diff">')
      expect(older).toContain('较早的一轮')
      // 更早的一轮照样能接受 / 打回:只是差异不就地展开。
      expect(older).toContain('data-action="review-accept"')
    }
  })

  it('整块面板共用一份预览额度,用完了只在底下说一次', () => {
    const budget = createReviewDiffBudget()
    const big = (/** @type {string} */ path) => file({ path, diff: '@@ -0,0 +9000 @@\n' + '+x\n'.repeat(9000) })
    const reviews = [
      turn({ artifactId: 'ART-1', sha256: 'a'.repeat(64), files: [big('one.ts'), big('two.ts')] }),
      turn({ artifactId: 'ART-2', sha256: 'b'.repeat(64), files: [big('three.ts')] }),
    ]
    const html = renderReviewPanel(reviews, options({ budget, renderDiff: (/** @type {any} */ f) => renderReviewFileDiff(f, escapeHtml, budget) }))
    expect(budget.limited).toBe(true)
    expect(html.match(/预览已限量显示/g)).toHaveLength(1)
    expect(html.lastIndexOf('预览已限量显示')).toBeGreaterThan(html.lastIndexOf('<section class="wb-review-turn"'))
    // 额度是整块面板共享的:后面的文件拿不到行数了,也不会假装自己完整。
    expect((html.match(/data-line=/g) ?? []).length).toBeLessThanOrEqual(4000)
    const roomy = renderReviewPanel([turn()], options({ budget: createReviewDiffBudget() }))
    expect(roomy).not.toContain('预览已限量显示')
  })

  it('签名跟着标记与快照内容走', () => {
    const base = [turn()]
    expect(reviewsSignature(base)).toBe(reviewsSignature([turn()]))
    expect(reviewsSignature(base)).not.toBe(reviewsSignature([turn({ files: [file({ mark: { mark: 'accepted', comment: '', createdAt: 1 } })] })]))
    expect(reviewsSignature(base)).not.toBe(reviewsSignature([turn({ sha256: 'c'.repeat(64) })]))
    expect(reviewsSignature(base)).not.toBe(reviewsSignature([...base, turn({ artifactId: 'ART-2', sha256: 'd'.repeat(64) })]))
    expect(reviewsSignature([])).toBe(reviewsSignature([]))
  })

  // 行评论(2026-10-21)之前的输出,逐字节钉住:不带 hunks / comments 的数据,带不带 lines 都一样
  it('不带块清单 / 评论的数据渲染得与以前逐字节相同', () => {
    const budgetFor = () => { const budget = createReviewDiffBudget(); return { budget, renderDiff: (/** @type {any} */ f, /** @type {any} */ l) => renderReviewFileDiff(f, escapeHtml, budget, l) } }
    const pinned = (/** @type {Record<string,unknown>} */ o = {}) => ({ path: 'src/app.ts', preexisting: false, kind: 'modified', diff: '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n@@ -10 +10 @@\n-x\n+y', ...o })
    const pinnedTurn = (/** @type {Record<string,unknown>} */ o = {}) => ({ artifactId: 'ART-1', sha256: 'a'.repeat(64), name: 'n.json', createdAt: 100, status: 'complete', headBefore: null, headAfter: null, preexistingPaths: [], notes: ['n1'], files: [pinned()], ...o })
    const reviews = [
      pinnedTurn({ artifactId: 'ART-3', sha256: 'c'.repeat(64), discarded: true, rewindable: { start: true, end: false } }),
      pinnedTurn({ artifactId: 'ART-2', sha256: 'b'.repeat(64), files: [pinned({ mark: { mark: 'returned', comment: '再改', createdAt: 1 }, risk: ['鉴权'] }), pinned({ path: 'big.bin', kind: 'not_reviewed', diff: undefined, reason: '二进制' })] }),
      pinnedTurn({ files: [pinned({ kind: 'added', diff: '@@ -0,0 +1 @@\n+z\n\\ No newline at end of file' })] }),
    ]
    const sha = (/** @type {string} */ html) => createHash('sha256').update(html).digest('hex')
    const base = { escapeHtml, formatTime, returnOpen: { artifactId: 'ART-2', paths: ['src/app.ts'], comment: 'x' } }
    const before = 'd3f469a264b8ec1b32e03e853fcf89444092ebdafd164902698f55ea37110816'
    expect(sha(renderReviewPanel(reviews, { ...base, ...budgetFor() }))).toBe(before)
    expect(sha(renderReviewPanel(reviews, { ...base, ...budgetFor(), lines: { select: null, compose: null, send: null } }))).toBe(before)
    expect(reviewsSignature(reviews)).toBe('[["' + 'c'.repeat(64) + '","complete",true,true,false,[["src/app.ts",null,""]]],["' + 'b'.repeat(64) + '","complete",[["src/app.ts","returned","再改"],["big.bin",null,""]]],["' + 'a'.repeat(64) + '","complete",[["src/app.ts",null,""]]]]')
  })
})

describe('行评论 + 按块撤回', () => {
  const DIFF = '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n@@ -10 +10 @@\n-x\n+y'
  const hunks = (/** @type {Record<string,unknown>[]} */ extra = [{}, {}]) => [
    { index: 0, sha256: '1'.repeat(64), header: '@@ -1,3 +1,3 @@', oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, rows: 4, ...extra[0] },
    { index: 1, sha256: '2'.repeat(64), header: '@@ -10 +10 @@', oldStart: 10, oldCount: 1, newStart: 10, newCount: 1, rows: 2, ...extra[1] },
  ]
  const lineFile = (/** @type {Record<string,unknown>} */ o = {}) => file({ diff: DIFF, hunks: hunks(), ...o })
  const real = (/** @type {Record<string,unknown>} */ extra = {}) => { const budget = createReviewDiffBudget(); return options({ budget, renderDiff: (/** @type {any} */ f, /** @type {any} */ l) => renderReviewFileDiff(f, escapeHtml, budget, l), lines: {}, ...extra }) }
  const draft = (/** @type {Record<string,unknown>} */ o = {}) => ({ id: 'c0ffee00-0000-4000-8000-000000000001', hunk: 0, rowStart: 1, rowEnd: 2, side: 'new', lineStart: 2, lineEnd: 2, body: '这里改成常量', state: 'draft', ...o })

  it('块清单对得上 ⇒ 每块一个块头 + 两个按钮,行带 data-hunk / data-row', () => {
    const html = renderReviewPanel([turn({ files: [lineFile()] })], real())
    expect(html.match(/class="wb-review-hunk"/g)).toHaveLength(2)
    expect(html).toContain('<code>@@ -1,3 +1,3 @@</code>')
    expect(html.match(/data-action="line-comment-hunk"/g)).toHaveLength(2)
    expect(html.match(/data-action="review-hunk" data-hunk-action="revert"/g)).toHaveLength(2)
    expect(html).toContain('>撤回这一块<')
    expect(html).toContain('data-hunk-sha="' + '1'.repeat(64) + '"')
    expect(html).toContain('<span data-line="deleted" data-hunk="0" data-row="1">-b</span>')
    expect(html).toContain('<span data-line="added" data-hunk="1" data-row="1">+y</span>')
    expect(html).toContain('data-review-lines data-artifact-id="ART-1" data-path="src/app.ts"')
    // 块头不再当一行出现在 pre 里
    expect(html).not.toContain('data-line="hunk"')
  })

  it('撤回过的块:小签「已撤回」+「恢复这一块」;新增的文件只能评论不能按块撤回', () => {
    const html = renderReviewPanel([turn({ files: [lineFile({ hunks: hunks([{ reverted: { at: 5 } }, {}]) })] })], real())
    expect(html).toContain('<span class="wb-review-badge" data-mark="reverted">已撤回</span>')
    expect(html).toContain('data-hunk-action="restore"')
    expect(html).toContain('>恢复这一块<')
    expect(html).toContain('data-reverted')
    const added = renderReviewPanel([turn({ files: [lineFile({ kind: 'added' })] })], real())
    expect(added).toContain('data-action="line-comment-hunk"')
    expect(added).not.toContain('data-action="review-hunk"')
  })

  it('客户端切块对不上 ⇒ 退回整段 pre,不给动作', () => {
    for (const bad of [hunks([{ rows: 3 }, {}]), hunks().slice(0, 1), hunks([{ header: '@@ -1,3 +1,4 @@' }, {}])]) {
      const html = renderReviewPanel([turn({ files: [lineFile({ hunks: bad })] })], real())
      expect(html).toContain('<pre class="wb-review-diff" aria-label="文件差异">')
      expect(html).toContain('<span data-line="hunk">@@ -1,3 +1,3 @@</span>')
      expect(html).not.toContain('data-row=')
      expect(html).not.toContain('data-action="line-comment-hunk"')
      expect(html).not.toContain('data-action="review-hunk"')
    }
    // 没给 lines(老调用方)也一样
    const budget = createReviewDiffBudget()
    expect(renderReviewPanel([turn({ files: [lineFile()] })], options({ renderDiff: (/** @type {any} */ f, /** @type {any} */ l) => renderReviewFileDiff(f, escapeHtml, budget, l) }))).not.toContain('data-row=')
  })

  it('撤掉的轮灰显只读:块头只剩小签,行不能选,草稿写明不会发出', () => {
    const html = renderReviewPanel([turn({ discarded: true, files: [lineFile({ hunks: hunks([{ reverted: { at: 1 } }, {}]), comments: [draft()] })] })], real({ lines: { select: { artifactId: 'ART-1', path: 'src/app.ts', hunk: 0, hunkSha256: '1'.repeat(64), anchor: 1, rowStart: 1, rowEnd: 1 } } }))
    expect(html).toContain('class="wb-review-hunk"')
    expect(html).toContain('已撤回')
    expect(html).not.toContain('data-row=')
    expect(html).not.toContain('data-action="line-comment-hunk"')
    expect(html).not.toContain('data-action="review-hunk"')
    expect(html).not.toContain('is-selected')
    expect(html).toContain('草稿 · 这一轮已撤掉，草稿不会发出')
    expect(html).not.toContain('data-action="line-comment-edit"')
    expect(html).not.toContain('data-action="line-comment-delete"')
    // 撤掉的轮上的草稿不算「待发出」
    expect(html).not.toContain('条评论待发出')
  })

  it('较早的一轮不就地展开,评论列在下面;额度用完的那一块只读', () => {
    const reviews = Array.from({ length: 4 }, (_, i) => turn({ artifactId: `ART-${i}`, sha256: String(i).repeat(64), files: [lineFile({ comments: i === 3 ? [draft()] : [] })] }))
    const html = renderReviewPanel(reviews, real())
    const older = html.split('<section class="wb-review-turn"').slice(1)[3] ?? ''
    expect(older).toContain('较早的一轮')
    expect(older).not.toContain('data-row=')
    expect(older).toContain('<div class="wb-line-comments">')
    expect(older).toContain('这里改成常量')
    // 额度只够第一块的块头 + 两行:那一块不给动作,后面的块不渲
    const budget = { charsLeft: 1000, linesLeft: 3, limited: false }
    const cut = renderReviewPanel([turn({ files: [lineFile({ comments: [draft()] })] })], options({ budget, renderDiff: (/** @type {any} */ f, /** @type {any} */ l) => renderReviewFileDiff(f, escapeHtml, budget, l), lines: {} }))
    expect(budget.limited).toBe(true)
    expect(cut.match(/class="wb-review-hunk"/g)).toHaveLength(1)
    expect(cut).not.toContain('data-row=')
    expect(cut).not.toContain('data-action="line-comment-hunk"')
    expect(cut).toContain('<div class="wb-line-comments">')
  })

  it('选中的行高亮,选区下给「评论」;点开后是就地输入框', () => {
    const select = { artifactId: 'ART-1', path: 'src/app.ts', hunk: 0, hunkSha256: '1'.repeat(64), anchor: 1, rowStart: 1, rowEnd: 2 }
    const html = renderReviewPanel([turn({ files: [lineFile()] })], real({ lines: { select } }))
    expect(html.match(/class="is-selected"/g)).toHaveLength(2)
    expect(html).toMatch(/data-row="2" class="is-selected">\+c<\/span><\/code><\/pre><div class="wb-line-select" data-line-select><span>已选 2 行<\/span><button type="button" class="wb-new" data-action="line-comment-open">评论<\/button>/)
    const compose = { artifactId: 'ART-1', path: 'src/app.ts', hunk: 0, hunkSha256: '1'.repeat(64), rowStart: 1, rowEnd: 2, commentId: 'x', body: '<b>草</b>' }
    const open = renderReviewPanel([turn({ files: [lineFile()] })], real({ lines: { compose } }))
    expect(open).toContain('<form class="wb-line-compose" data-action="line-comment-save">')
    expect(open).toContain('placeholder="这几行要怎么改…"')
    expect(open).toContain('>存为草稿</button>')
    expect(open).toContain('data-action="line-comment-cancel">取消</button>')
    expect(open).toContain('&lt;b&gt;草&lt;/b&gt;')
    // 整块评论的输入框落在块尾
    const whole = renderReviewPanel([turn({ files: [lineFile()] })], real({ lines: { compose: { ...compose, rowStart: undefined, rowEnd: undefined, hunk: 1 } } }))
    expect(whole).toMatch(/\+y<\/span><\/code><\/pre><form class="wb-line-compose"/)
  })

  it('评论就地显示:草稿给改 / 删,已发出写时间与之后改没改过', () => {
    const comments = [
      draft(),
      draft({ id: 'c0ffee00-0000-4000-8000-000000000002', state: 'sent', sentAt: 77, laterTouched: 3, hunk: 1, rowStart: 0, rowEnd: 0, side: 'old', lineStart: 10, lineEnd: 10, body: '别删这行' }),
      draft({ id: 'c0ffee00-0000-4000-8000-000000000003', state: 'sent', sentAt: 78, rowStart: undefined, rowEnd: undefined, lineStart: 1, lineEnd: 3, body: '<script>x()</script>' }),
    ]
    const html = renderReviewPanel([turn({ files: [lineFile({ comments })] })], real())
    expect(html).toMatch(/data-row="2">\+c<\/span><\/code><\/pre><div class="wb-line-comment" data-comment-id="c0ffee00-0000-4000-8000-000000000001" data-state="draft"><p class="wb-line-comment-meta"><span>草稿<\/span><span>第 2 行<\/span>/)
    expect(html).toContain('data-action="line-comment-edit" data-comment-id="c0ffee00-0000-4000-8000-000000000001">改</button>')
    expect(html).toContain('data-action="line-comment-delete" data-comment-id="c0ffee00-0000-4000-8000-000000000001">删</button>')
    expect(html).toContain('<span>已发出 · T77</span><span>原第 10 行（已删）</span>')
    expect(html).toContain('之后第 3 轮又改过这个文件')
    expect(html).toContain('<span>已发出 · T78</span><span>第 1–3 行</span>')
    expect(html).toContain('之后没再动过这个文件')
    expect(html).toContain('&lt;script&gt;x()&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html.match(/data-action="line-comment-edit"/g)).toHaveLength(1)
    // 改一条:输入框顶替那条评论
    const editing = renderReviewPanel([turn({ files: [lineFile({ comments })] })], real({ lines: { compose: { artifactId: 'ART-1', path: 'src/app.ts', hunk: 0, commentId: 'c0ffee00-0000-4000-8000-000000000001', body: '改过的', edit: true } } }))
    expect(editing).toContain('>改过的</textarea>')
    expect(editing).not.toContain('data-comment-id="c0ffee00-0000-4000-8000-000000000001" data-state="draft"')
  })

  it('发出栏:N 条待发出、撤掉的轮另说、要重开时换按钮、发完照实说', () => {
    const reviews = [turn({ files: [lineFile({ comments: [draft(), draft({ id: 'b', state: 'sent', sentAt: 1 })] })] }), turn({ artifactId: 'ART-0', sha256: 'f'.repeat(64), discarded: true, files: [lineFile({ comments: [draft({ id: 'z' })] })] })]
    const html = renderReviewPanel(reviews, real({ lines: { send: { summary: '整体再收一收', notice: '执行者还在写' } } }))
    expect(html).toContain('<form class="wb-review-send" data-action="line-comments-send"><p class="wb-review-send-count">1 条评论待发出</p>')
    expect(html).toContain('另有 1 条草稿在撤掉的轮上，不会发出。')
    expect(html).toContain('placeholder="整体说一句（可不写）">整体再收一收</textarea>')
    expect(html).toContain('执行者还在写')
    expect(html).toContain('>发出评论</button>')
    expect(renderReviewPanel(reviews, real({ lines: { send: { restartToken: 'c'.repeat(64) } } }))).toContain('>带记录重新开始并发回</button>')
    const sent = [turn({ files: [lineFile({ comments: [draft({ state: 'sent', sentAt: 1 })] })] })]
    expect(renderReviewPanel(sent, real())).not.toContain('wb-review-send')
    const after = renderReviewPanel(sent, real({ lines: { send: { result: '已发出 1 条评论。' } } }))
    expect(after).toContain('<div class="wb-review-send"><p class="wb-review-note" role="status">已发出 1 条评论。</p></div>')
    expect(after).not.toContain('data-action="line-comments-send"')
  })

  it('签名跟着块的撤回小签与评论的 id / 状态 / 正文走', () => {
    const sig = (/** @type {Record<string,unknown>} */ o) => reviewsSignature([turn({ files: [lineFile(o)] })])
    const base = sig({})
    expect(sig({})).toBe(base)
    expect(sig({ hunks: hunks([{ reverted: { at: 5 } }, {}]) })).not.toBe(base)
    expect(sig({ hunks: hunks([{ reverted: { at: 5 } }, {}]) })).not.toBe(sig({ hunks: hunks([{ reverted: { at: 6 } }, {}]) }))
    const one = sig({ comments: [draft()] })
    expect(one).not.toBe(base)
    expect(sig({ comments: [draft({ body: '换了' })] })).not.toBe(one)
    expect(sig({ comments: [draft({ state: 'sent', sentAt: 1 })] })).not.toBe(one)
    expect(sig({ comments: [draft({ id: 'other' })] })).not.toBe(one)
  })
})
