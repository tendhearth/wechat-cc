// settings-projects.spec.ts — 项目管理 list in the settings drawer.
//
// The old sessions pane (project list with favorite-star + delete) was
// replaced by the data-driven 対話 pane, leaving deleteProject /
// toggleFavorite without a GUI surface. This re-wires them into a compact
// list inside the settings drawer:
//   - the drawer lists seeded projects with a favorite star + delete button
//   - clicking the star toggles the favorite class
//   - delete is two-step (arm → confirm) and removes the row

import { test, expect } from './fixtures'

async function bootDashboard(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(
    () => {
      const m = document.documentElement.dataset.mode
      return m !== undefined && m !== 'loading'
    },
    { timeout: 15_000 }
  )
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 5_000 })
}

test('settings drawer lists seeded projects with favorite + delete affordances', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootDashboard(page, shimUrl)

  await page.locator('#settings-open').click()
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/, { timeout: 5_000 })

  const list = page.locator('#projects-admin-list')
  const rows = list.locator('.project-admin-row')
  await expect(rows.first()).toBeVisible({ timeout: 5_000 })
  const initialCount = await rows.count()
  expect(initialCount).toBeGreaterThan(0)

  // Toggle favorite on the first row → it gains the is-favorite class.
  const firstRow = rows.first()
  const alias = await firstRow.getAttribute('data-alias')
  await firstRow.locator('.project-admin-star').click()
  await expect(list.locator(`.project-admin-row[data-alias="${alias}"]`)).toHaveClass(/is-favorite/, { timeout: 5_000 })
})

test('settings drawer delete is two-step and removes the project row', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootDashboard(page, shimUrl)

  await page.locator('#settings-open').click()
  await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/, { timeout: 5_000 })

  const list = page.locator('#projects-admin-list')
  await expect(list.locator('.project-admin-row').first()).toBeVisible({ timeout: 5_000 })
  const before = await list.locator('.project-admin-row').count()

  const firstRow = list.locator('.project-admin-row').first()
  const alias = await firstRow.getAttribute('data-alias')
  const row = list.locator(`.project-admin-row[data-alias="${alias}"]`)

  // First click arms — the button switches to the confirm copy ("再点确认")
  // and the row is NOT yet removed.
  await row.locator('.project-admin-del').click()
  await expect(row).toContainText('再点确认', { timeout: 3_000 })
  await expect(row).toHaveCount(1)

  // Second click confirms → row gone, count drops by one.
  await row.locator('.project-admin-del').click()
  await expect(row).toHaveCount(0, { timeout: 5_000 })
  await expect(list.locator('.project-admin-row')).toHaveCount(before - 1)
})
