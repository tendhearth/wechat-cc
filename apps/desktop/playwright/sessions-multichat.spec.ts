// sessions-multichat.spec.ts — Multi-chat navigation in the 対話 pane.
//
// Task 11: Ported from the old sessions pane (Task 9) which used:
//   #sessions-sidebar / .contact-row / #sessions-body / #sessions-empty
//
// In the new dialogue page (Task 10) the same multi-chat concept is served by:
//   #dialogue-chat-switcher / .dialogue-chat-row / #dialogue-timeline
//
// The scenarios are preserved 1:1:
//   - Two contacts → switcher shows both names
//   - Selecting a contact reloads the view for that chat
//   - Single contact → switcher is hidden, timeline still shows
//   - Zero contacts → switcher hidden, timeline shows empty-state
//
// Note: The "selecting a contact filters the session LIST to that contact"
// scenario can no longer assert on sessions/projects (wechat-cc / compass /
// blog) because the dialogue page shows a message TIMELINE, not a project list.
// Instead we assert that clicking the second contact causes the timeline to
// reload (which in the mock always calls dialogue timeline with the new
// --chat-id, returning an empty response for the second chat since only the
// first has messages seeded). This proves the routing fires; more nuanced
// per-chat content can be tested with explicit mock setup in
// dialogue-timeline.spec.ts.

import { test, expect } from './fixtures'

async function bootAndOpenDialogue(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )
  await page.evaluate(() => {
    document.documentElement.dataset.mode = 'dashboard'
  })
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 5_000 })
  await page.locator('button.dash-nav-link[data-pane="sessions"]').click()
  await expect(page.locator('article.dash-pane[data-pane="sessions"]')).toBeVisible()
}

// 已删除两条用例(2026-08-03):「chat switcher lists each seeded contact」与
// 「selecting a contact switches the active chat row」。
//
// 它们断言 #dialogue-chat-switcher 列出多个联系人行并可点击切换。会话页改版后
// 该功能**被有意移除**:dialogue-page.js 显式常驻隐藏它并清空内容,注释写着
// 「The sidebar design no longer shows the chat switcher rows」。实测确认整个
// sessions pane 里 [data-chat] 元素为 0 —— 没有替代入口可改测。
//
// 这是 desktop-e2e 从 ~2026-07-08 起持续红的一部分。保留一条永远红的用例,只会
// 掩盖真正的回归;而本文件下面那条「switcher hidden, timeline still renders」
// 已经钉住了改版后的正确行为(与被删的两条恰好相反)。
//
// 若将来重新引入多联系人切换,请连同新的 DOM 结构一起补测试,而不是复活这两条。

test('single chat (no session records): switcher hidden, timeline still renders', async ({ page, shimUrl, shim }) => {
  // withSessions: false means no sessions/project records exist, but there
  // may still be conversation history. The new dialogue page shows the
  // timeline regardless — the switcher is simply hidden when there's only
  // one (or zero) contacts. The old sessions page showed #sessions-empty;
  // in the dialogue world the single-chat case just silently hides the
  // switcher and shows whatever messages exist for that chat.
  await shim.invoke('demo.seed', { chat_id: 'test_chat', withSessions: false })
  await bootAndOpenDialogue(page, shimUrl)
  await expect(page.locator('#dialogue-root')).toBeVisible({ timeout: 10_000 })
  // Switcher must be hidden since list-chats returns 1 chat (fallback from chats state).
  await expect(page.locator('#dialogue-chat-switcher')).toBeHidden({ timeout: 10_000 })
  // Timeline renders (dialogue messages were seeded).
  await expect(page.locator('#dialogue-timeline')).toBeVisible()
})
