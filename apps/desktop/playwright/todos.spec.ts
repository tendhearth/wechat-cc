// 待办(todos)面板 —— 2026-08-24 导航重构把它升为一级入口,并【取代】了
// 客户回顾(那次提交:「客户回顾并入待办(入口退役)」)。
//
// 为什么有这个文件:客户回顾原本有 8 条 e2e,入口退役后它们全部失败,
// 被一并删除;而接替它的待办当时【一条 e2e 都没有】。这里补上最小骨架
// 覆盖,免得一次"功能搬家"变成净覆盖下降 —— 这正是那 19 条红能在
// e2e-browser 里躺七天没人认领的土壤。
import { test, expect } from './fixtures'

async function openTodos(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'dashboard', { timeout: 10_000 })
  await page.locator('button.dash-nav-link[data-pane="todos"]').click()
  await expect(page.locator('article.dash-pane[data-pane="todos"]')).toBeVisible()
}

test('待办是一级导航入口,点开后面板可见', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await openTodos(page, shimUrl)
  await expect(page.locator('button.dash-nav-link[data-pane="todos"]')).toBeAttached()
})

test('待办面板渲染出自己的骨架(root + 刷新入口)', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await openTodos(page, shimUrl)
  const pane = page.locator('article.dash-pane[data-pane="todos"]')
  await expect(pane.locator('#todos-root')).toBeAttached()
  // renderSkeleton 跑过之后才会有这两个;它们是"模块真的被挂上了"的证据,
  // 而不只是 index.html 里那个空 div。
  await expect(pane.locator('#todos-refresh')).toBeAttached({ timeout: 10_000 })
  await expect(pane.locator('#todos-list')).toBeAttached()
})
