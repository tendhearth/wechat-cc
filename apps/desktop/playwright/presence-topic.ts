import type { Page } from '@playwright/test'

type Source = () => unknown | Promise<unknown>

/**
 * 桌宠订的 presence 主题(S5,GET /v1/subscribe/presence)在 spec 里的替身:以前各 spec 分别 route
 * `/v1/companion/presence` 和 `/v1/companion/pet`,现在两半由这里拼成一份。没给的那一半照旧从 shim 拿
 * (演示状态:presence 按 demo.seed,pet 为 null)。
 *
 * 像 daemon 一样:内容变了 cursor 才加一;since 和现在的一样就短挂一会儿(≤300ms,每 50ms 重读一次两个源)
 * 再回原样 —— 挂得短,用假时钟的 spec 每走一步都等得到请求落地;两个源被重读的次数就是以前「拉了几次」。
 * 返回读到第几份的计数器,给要数「又观察了一次」的 spec 用。
 */
export async function routePresenceTopic(page: Page, o: { presence?: Source; pet?: Source }): Promise<{ reads: () => number }> {
  let cursor = 1, lastKey = '', reads = 0
  await page.route('**/v1/subscribe/presence**', async route => {
    const url = new URL(route.request().url())
    const since = url.searchParams.get('since')
    const hold = Math.min(Number(url.searchParams.get('wait_ms') ?? 0) || 0, 300)
    const read = async () => {
      const base = o.presence && o.pet ? {} as { presence?: unknown; pet?: unknown }
        : await (await route.fetch({ url: `${url.origin}${url.pathname}` })).json() as { presence?: unknown; pet?: unknown }
      const body = { presence: o.presence ? await o.presence() : base.presence ?? null, pet: o.pet ? await o.pet() : base.pet ?? null }
      reads++
      const key = JSON.stringify(body)
      if (key !== lastKey) { lastKey = key; cursor++ }
      return { cursor, ...body }
    }
    let reply = await read()
    const deadline = Date.now() + hold
    while (since !== null && Number(since) === reply.cursor && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50)); reply = await read()
    }
    await route.fulfill({ json: reply }).catch(() => { /* 页面已经走了 */ })
  })
  return { reads: () => reads }
}

export const PRESENCE_OK = { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } }
