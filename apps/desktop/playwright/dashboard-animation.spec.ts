import { test, expect, clickNav } from './fixtures'

test('inline companion animation replaces the overview illustration', async ({ page, shimUrl, shim }) => {
  // 场景里要有 CC 才能测悬停问候:presence 由 shim 的 /v1/companion/presence 提供,默认在线空闲。
  await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: true, presence: { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } } })
  await page.goto(shimUrl)
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'dashboard')

  // 2026-10-01 起鱼缸是「生活与工具 › 鱼缸」里的一页(此刻只留 CC)。
  await expect(page.locator('article[data-pane="overview"] #companion-stage')).toHaveCount(0)
  await clickNav(page, 'aquarium')
  await expect(page.locator('article[data-pane="aquarium"]')).toBeVisible()
  const canvas = page.locator('#companion-stage')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('inline companion canvas is missing')

  const firstHeroLetter = page.locator('#hero-headline .hero-letter').first()
  await expect(firstHeroLetter).toBeVisible()
  await firstHeroLetter.hover()
  await expect.poll(() => firstHeroLetter.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('1')

  await page.mouse.move(box.x + box.width * .72, box.y + box.height * .52)
  await expect(page.locator('#stage-hint')).toContainText('它们发现你了')

  // 螃蟹的位置由场景决定(#102 换了插画后它挪了家),从场景读,不写死像素。
  const crab = await page.evaluate(() => (window as any).__companionScene.crabSpot() as { x: number, y: number })
  await page.mouse.move(box.x + box.width * crab.x, box.y + box.height * crab.y)
  await expect(page.locator('#stage-hint')).toContainText('点点小螃蟹')
  await page.mouse.click(box.x + box.width * crab.x, box.y + box.height * crab.y)
  // 被点后要么换个地方藏,要么沿鱼缸逃走 —— 哪一种由场景随机决定,两种都是「它动了」。
  await expect(page.locator('#stage-hint')).toHaveText(/换个地方藏起来|沿着鱼缸逃走/)
  await page.waitForTimeout(1250)
  await expect(page.locator('#crab-escape')).toHaveCSS('opacity', '0')

  // 这里原本断言的是问候语数组里具体的第 1 句和第 2 句。真正要验的行为是
  // 「重新悬停会轮到下一句」,而不是「那两句必须是这两个字符串」—— 后者把测试
  // 和文案锁死,改一个字或调一次顺序就红,而且起始索引本就依赖此前的交互。
  const bearMsg = page.locator('#bear-message')
  await page.mouse.move(box.x + box.width * .25, box.y + box.height * .55)
  await expect(bearMsg).toHaveClass(/is-visible/)
  await expect(bearMsg).not.toBeEmpty()
  const firstGreeting = (await bearMsg.textContent())?.trim() ?? ''

  // 移开再回来:应当换一句,而不是重复同一句
  await page.mouse.move(box.x + box.width * .62, box.y + box.height * .52)
  await page.mouse.move(box.x + box.width * .25, box.y + box.height * .55)
  await expect(bearMsg).toHaveClass(/is-visible/)
  await expect(bearMsg).not.toHaveText(firstGreeting)

  await page.locator('#companion-immersive-start').click()
  await expect(page.locator('.moment-body')).toHaveClass(/is-companion-immersive/)
  // 2026-10-01 起用户与连接住在「连接与设置」:沉浸模式的「用户」打开那个抽屉的「连接」段,点抽屉外收起,沉浸不受影响。
  const drawer = page.locator('#settings-drawer')
  await expect(page.locator('#companion-users-toggle')).toHaveText('用户')
  await page.locator('#companion-users-toggle').click()
  await expect(drawer).toHaveClass(/is-open/)
  await expect(drawer.locator('.drawer-connection')).toBeVisible()
  await expect(drawer.locator('#accounts-current')).toBeVisible()
  // 在抽屉外找一个真正露出来的点(不是侧栏、不是抽屉)再点 —— 要验的是「点外面收起抽屉」,不是某个像素。
  const spot = await page.evaluate(() => {
    const d = document.querySelector('#settings-drawer'), rail = document.querySelector('#dash-global-rail')
    for (const [x, y] of [[640, 700], [640, 360], [400, 700], [500, 200], [300, 500], [250, 690], [850, 690], [600, 60]]) {
      const hit = document.elementFromPoint(x, y)
      if (hit && !d?.contains(hit) && !rail?.contains(hit) && !hit.closest('button, a')) return { x, y }
    }
    return null
  })
  if (!spot) throw new Error('no exposed point outside the settings drawer')
  await page.mouse.click(spot.x, spot.y)
  await expect(drawer).not.toHaveClass(/is-open/)
  await expect(page.locator('.moment-body')).toHaveClass(/is-companion-immersive/)
  await page.locator('#companion-immersive-exit').click()
  await expect(page.locator('.moment-body')).not.toHaveClass(/is-companion-immersive/)

  const desktopPagePromise = page.context().waitForEvent('page')
  await page.locator('#companion-desktop-start').click()
  const desktopPage = await desktopPagePromise
  await desktopPage.waitForLoadState()
  await expect(desktopPage.locator('#pet-stage')).toBeVisible()
  await expect(desktopPage.locator('#companion-window-close')).toBeVisible()
  await desktopPage.close()
})
