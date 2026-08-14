import { test, expect } from "./fixtures"

async function openDialogue(page: import("@playwright/test").Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => document.documentElement.dataset.mode !== "loading", { timeout: 15_000 })
  await page.evaluate(() => { document.documentElement.dataset.mode = "dashboard" })
  await expect(page.locator("main.dashboard")).toBeVisible()
  await page.locator('button.dash-nav-link[data-pane="sessions"]').click()
}

test("customer review is a secondary view and does not replace the dialogue default", async ({ page, shimUrl }) => {
  await openDialogue(page, shimUrl)

  await expect(page.locator('[data-dialogue-mode="cc"]')).toHaveAttribute("aria-selected", "true")
  await expect(page.locator("#dialogue-root")).toBeVisible()
  await expect(page.locator("#customer-review-root")).toBeHidden()

  await page.locator('[data-dialogue-mode="customer-review"]').click()
  await expect(page.locator("#dialogue-root")).toBeHidden()
  await expect(page.locator("#customer-review-root")).toBeVisible()
  await expect(page.getByRole("heading", { name: "客户回顾", exact: true })).toBeVisible()
  await expect(page.locator("#customer-review-search")).toBeVisible()
  await expect(page.locator("#customer-review-submit")).toBeDisabled()
  await expect(page.locator("#customer-review-root")).toContainText("不会自动向联系人发送消息")
})

test("customer review defaults to the recent three months", async ({ page, shimUrl }) => {
  await openDialogue(page, shimUrl)
  await page.locator('[data-dialogue-mode="customer-review"]').click()
  const values = await page.locator("#customer-review-root").evaluate(root => ({
    from: (root.querySelector("#customer-review-from") as HTMLInputElement).value,
    to: (root.querySelector("#customer-review-to") as HTMLInputElement).value,
  }))
  expect(values.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(values.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  const from = new Date(`${values.from}T12:00:00`)
  const to = new Date(`${values.to}T12:00:00`)
  expect((to.getFullYear() * 12 + to.getMonth()) - (from.getFullYear() * 12 + from.getMonth())).toBe(3)
})

test("previously reviewed customers are an entry point to their history", async ({ page, shimUrl }) => {
  await page.route("**/v1/customer-review**", async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/recent")) {
      return route.fulfill({ json: { contacts: [{
        contactId: "contact-old", displayName: "历史客户", reviewCount: 3,
        lastReviewAt: "2026-07-14T10:00:00.000Z", lastStatus: "ready",
      }] } })
    }
    if (url.pathname.endsWith("/history")) {
      return route.fulfill({ json: { reviews: [{
        id: "review-old", contactId: "contact-old", contactDisplayName: "历史客户",
        rangeFrom: "2026-04-01", rangeTo: "2026-06-30", status: "ready", provider: "codex",
        sourceMessageCount: 12, createdAt: "2026-07-14T10:00:00.000Z", items: [],
      }] } })
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } })
  })

  await openDialogue(page, shimUrl)
  await page.locator('[data-dialogue-mode="customer-review"]').click()
  await expect(page.locator("#customer-review-recent")).toContainText("历史客户")
  await expect(page.locator("#customer-review-recent")).toContainText("3 次回顾")
  await page.locator('[data-recent-contact-id="contact-old"]').click()
  await expect(page.locator("#customer-review-selected-contact")).toContainText("历史客户")
  await expect(page.locator("#customer-review-history")).toContainText("2026.04.01 — 2026.06.30")
})

test("customer review waits for its daemon runtime instead of showing a startup error", async ({ page, shimUrl }) => {
  let attempts = 0
  await page.route("**/v1/customer-review/recent", async route => {
    attempts += 1
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: "customer_review_not_wired" } })
    return route.fulfill({ json: { contacts: [{
      contactId: "contact-ready", displayName: "刚启动的客户", reviewCount: 1,
      lastReviewAt: "2026-07-15T10:00:00.000Z", lastStatus: "ready",
    }] } })
  })

  await openDialogue(page, shimUrl)
  await page.locator('[data-dialogue-mode="customer-review"]').click()
  await expect(page.locator("#customer-review-recent")).toContainText("刚启动的客户", { timeout: 3_000 })
  expect(attempts).toBe(2)
})

test("a partially analyzed long range keeps grounded results and identifies uncovered spans", async ({ page, shimUrl }) => {
  const partialReview = {
    id: "review-partial", contactId: "contact-long", contactDisplayName: "长聊天客户",
    rangeFrom: "2026-04-15", rangeTo: "2026-07-15", status: "ready", provider: "codex",
    sourceMessageCount: 420, createdAt: "2026-07-15T10:00:00.000Z", items: [],
    analysisIssues: [{ windowIndex: 1, rangeFrom: "2026-06-10T09:00:00.000Z", rangeTo: "2026-06-18T18:00:00.000Z", attempts: 2 }],
  }
  await page.route("**/v1/customer-review**", async route => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname.endsWith("/recent")) return route.fulfill({ json: { contacts: [] } })
    if (url.pathname.endsWith("/contacts")) return route.fulfill({ json: { contacts: [{ id: "contact-long", displayName: "长聊天客户", kind: "private" }] } })
    if (url.pathname.endsWith("/history")) return route.fulfill({ json: { reviews: [] } })
    if (url.pathname === "/v1/customer-review" && method === "POST") return route.fulfill({ status: 202, json: { id: "review-partial", status: "queued" } })
    if (url.pathname === "/v1/customer-review" && method === "GET") return route.fulfill({ json: { review: partialReview } })
    return route.fulfill({ status: 404, json: { error: "not_found" } })
  })

  await openDialogue(page, shimUrl)
  await page.locator('[data-dialogue-mode="customer-review"]').click()
  await page.locator("#customer-review-search").fill("长聊天")
  await page.locator('[data-contact-id="contact-long"]').click()
  await page.locator("#customer-review-submit").click()
  await expect(page.locator("#customer-review-detail")).toContainText("部分完成", { timeout: 5_000 })
  await expect(page.locator("#customer-review-detail")).toContainText("1 个聊天片段未通过核对，未纳入结果")
  await page.locator(".customer-review-coverage summary").click()
  await expect(page.locator(".customer-review-coverage")).toContainText("已尝试 2 次")
  await expect(page.locator("#customer-review-detail")).toContainText("已完成部分分析，暂未生成可核对承诺")
})

test("contact selection, analysis result and confirmation form one usable flow", async ({ page, shimUrl }) => {
  const baseReview = {
    id: "review-1",
    contactId: "contact-1",
    contactDisplayName: "章超",
    rangeFrom: "2026-04-15",
    rangeTo: "2026-07-15",
    status: "ready",
    provider: "codex",
    sourceMessageCount: 42,
    createdAt: "2026-07-15T10:00:00.000Z",
    completedAt: "2026-07-15T10:00:05.000Z",
    items: [{
      sourceKey: "0123456789abcdef01234567",
      commitment: "把新版报价单发给客户",
      aiStatus: "open",
      confidence: "high",
      reviewStatus: "unreviewed",
      createdAt: "2026-07-15T10:00:05.000Z",
      updatedAt: "2026-07-15T10:00:05.000Z",
      evidence: [{ evidenceKey: "e1", role: "commitment", messageTime: "2026-06-28T09:30:00.000Z", senderSide: "me" }],
    }],
  }
  let reviewedItem = { ...baseReview.items[0] }
  await page.route("**/v1/customer-review**", async route => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname.endsWith("/contacts")) {
      return route.fulfill({ json: { contacts: [{ id: "contact-1", displayName: "章超", kind: "private", preview: "上次沟通报价方案" }] } })
    }
    if (url.pathname.endsWith("/history")) return route.fulfill({ json: { reviews: [] } })
    if (url.pathname.endsWith("/evidence")) {
      return route.fulfill({ json: { evidence: [{
        evidenceKey: "e1", role: "commitment", messageTime: "2026-06-28T09:30:00.000Z", senderSide: "me",
        text: "我今天把新版报价单整理好后发给你。", messageType: "text",
      }] } })
    }
    if (url.pathname.endsWith("/item")) {
      const body = route.request().postDataJSON() as { status: string, corrected_text?: string }
      reviewedItem = { ...reviewedItem, reviewStatus: body.status, ...(body.corrected_text ? { correctedText: body.corrected_text } : {}) }
      return route.fulfill({ json: { review: { ...baseReview, items: [reviewedItem] } } })
    }
    if (url.pathname === "/v1/customer-review" && method === "POST") return route.fulfill({ status: 202, json: { id: "review-1", status: "queued" } })
    if (url.pathname === "/v1/customer-review" && method === "GET") return route.fulfill({ json: { review: baseReview } })
    return route.fulfill({ status: 404, json: { error: "not_found" } })
  })

  await openDialogue(page, shimUrl)
  await page.locator('[data-dialogue-mode="customer-review"]').click()
  await page.locator("#customer-review-search").fill("章超")
  await expect(page.locator("#customer-review-contact-results")).toContainText("章超")
  await page.locator('[data-contact-id="contact-1"]').click()
  await expect(page.locator("#customer-review-selected-contact")).toContainText("已选择")
  await expect(page.locator("#customer-review-submit")).toBeEnabled()

  await page.locator("#customer-review-submit").click()
  await expect(page.locator("#customer-review-detail")).toContainText("正在回顾与 章超 的沟通")
  await expect(page.locator("#customer-review-detail")).toContainText("通常会在几秒内开始分析")
  await expect(page.locator(".customer-review-item")).toContainText("把新版报价单发给客户", { timeout: 5_000 })
  await expect(page.locator(".customer-review-item")).toContainText("聊天依据 · 1 条")
  await page.locator(".customer-review-evidence summary").click()
  await expect(page.locator(".customer-review-evidence")).toContainText("我今天把新版报价单整理好后发给你。")

  await expect(page.locator(".customer-review-item")).toContainText("微信中未发现完成证据")
  await page.locator('[data-item-action="edit"]').click()
  await page.locator(".customer-review-edit textarea").fill("将新版报价单发给客户")
  await page.locator('[data-item-action="save-edit"]').click()
  await expect(page.locator(".customer-review-review-status")).toHaveText("已修订，待确认")
  await expect(page.locator(".customer-review-item")).toContainText("将新版报价单发给客户")
  await expect(page.locator(".customer-review-item-actions")).toContainText("文字已修改，请确认这项现在的处理状态")
  await expect(page.locator(".customer-review-item-actions")).toContainText("仍待处理")
  await expect(page.locator(".customer-review-item-actions")).toContainText("已通过其他方式完成")
  await expect(page.locator(".customer-review-item-actions")).toContainText("已通过其他方式完成")
  await page.locator('[data-item-action="complete-elsewhere"]').click()
  await expect(page.locator(".customer-review-review-status")).toHaveText("已通过其他方式完成")
  await expect(page.locator(".customer-review-item-actions")).toBeHidden()
})

test("an action on one item keeps an unsaved correction on another", async ({ page, shimUrl }) => {
  // renderDetail rewrites the whole panel and runs on every item action and
  // every poll tick, so editing item A and then acting on item B silently
  // destroyed A's draft with no way to get it back (2026-07-28 review).
  const item = (sourceKey: string, commitment: string) => ({
    sourceKey, commitment, aiStatus: "open", confidence: "high", reviewStatus: "unreviewed",
    createdAt: "2026-07-15T10:00:05.000Z", updatedAt: "2026-07-15T10:00:05.000Z", evidence: [],
  })
  const review = {
    id: "review-draft", contactId: "contact-1", contactDisplayName: "章超",
    rangeFrom: "2026-04-15", rangeTo: "2026-07-15", status: "ready", provider: "codex",
    sourceMessageCount: 42, createdAt: "2026-07-15T10:00:00.000Z", completedAt: "2026-07-15T10:00:05.000Z",
    items: [
      item("0123456789abcdef01234567", "把新版报价单发给客户"),
      item("89abcdef0123456789abcdef", "把合同寄给客户"),
    ],
  }
  await page.route("**/v1/customer-review**", async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/recent")) return route.fulfill({ json: { contacts: [{ contactId: "contact-1", displayName: "章超", reviewCount: 1, lastReviewAt: "2026-07-15T10:00:05.000Z", lastStatus: "ready" }] } })
    if (url.pathname.endsWith("/history")) return route.fulfill({ json: { reviews: [review] } })
    if (url.pathname.endsWith("/item")) return route.fulfill({ json: { review } })
    return route.fulfill({ json: { review } })
  })
  await openDialogue(page, shimUrl)
  await page.locator('[data-dialogue-mode="customer-review"]').click()
  await page.locator('[data-recent-contact-id="contact-1"]').click()
  await page.locator('[data-review-id="review-draft"]').click()
  await page.locator('[data-source-key="0123456789abcdef01234567"] [data-item-action="edit"]').click()

  const draft = page.locator('[data-source-key="0123456789abcdef01234567"] textarea')
  await draft.fill("把新版报价单在周五前发给章总")
  // Act on the OTHER item — this is what used to wipe the draft above.
  await page.locator('[data-source-key="89abcdef0123456789abcdef"] [data-item-action="confirm"]').click()

  await expect(draft).toHaveValue("把新版报价单在周五前发给章总")
  await expect(page.locator('[data-source-key="0123456789abcdef01234567"] .customer-review-edit')).toBeVisible()
})

test("withheld AI output explains the reliability safeguard instead of a generic failure", async ({ page, shimUrl }) => {
  await page.route("**/v1/customer-review**", async route => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname.endsWith("/contacts")) return route.fulfill({ json: { contacts: [{ id: "contact-1", displayName: "章超", kind: "private" }] } })
    if (url.pathname.endsWith("/history")) return route.fulfill({ json: { reviews: [] } })
    if (url.pathname === "/v1/customer-review" && method === "POST") return route.fulfill({ status: 202, json: { id: "review-failed", status: "queued" } })
    if (url.pathname === "/v1/customer-review" && method === "GET") {
      return route.fulfill({ json: { review: {
        id: "review-failed", contactId: "contact-1", contactDisplayName: "章超", rangeFrom: "2026-04-15", rangeTo: "2026-07-15",
        status: "failed", provider: "codex", sourceMessageCount: 0, errorCode: "AI_INVALID_AI_OUTPUT", createdAt: "2026-07-15T10:00:00.000Z", items: [],
      } } })
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } })
  })

  await openDialogue(page, shimUrl)
  await page.locator('[data-dialogue-mode="customer-review"]').click()
  await page.locator("#customer-review-search").fill("章超")
  await page.locator('[data-contact-id="contact-1"]').click()
  await page.locator("#customer-review-submit").click()
  await expect(page.locator("#customer-review-detail")).toContainText("这次没有生成可核对的结果", { timeout: 5_000 })
  await expect(page.locator("#customer-review-detail")).toContainText("避免把聊天内容误判为承诺")
  await expect(page.locator("#customer-review-detail")).toContainText("缩短时间范围")
  await expect(page.getByRole("button", { name: "重新分析" })).toBeVisible()
})
