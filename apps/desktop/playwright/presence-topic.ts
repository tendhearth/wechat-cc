import type { Page } from '@playwright/test'

type Source = () => unknown | Promise<unknown>

/**
 * 桌宠订的 presence 主题(S5,GET /v1/subscribe/presence)在 spec 里的替身:以前各 spec 分别 route
 * `/v1/companion/presence` 和 `/v1/companion/pet`,现在两半由这里拼成一份。没给的那一半照旧从 shim 拿
 * (presence 读 shim 的 /v1/companion/presence,按 demo.seed;pet 为 null —— 演示模式没有「在做什么」)。
 *
 * 像 daemon 一样:内容变了 cursor 才加一;since 和现在的一样就挂着(每 50ms 重读一次两个源,变了马上回),
 * 最多挂 holdMs(默认 2 秒,比真 daemon 的 20 秒短,好让 spec 里「再来一份」等得不久)再回原样。
 * 桌面收到 cursor 没变的那份不会重画。两个源被重读的次数就是以前「拉了几次」。
 * 不用 route.fetch:挂着的回调在 spec 结束以后还会跑,route.fetch 那时会抛「Test ended」,把下一个 spec 也弄红。
 */
export async function routePresenceTopic(page: Page, o: { presence?: Source; pet?: Source; holdMs?: number }): Promise<void> {
  let cursor = 1, lastKey = ''
  const holdMs = o.holdMs ?? 2_000
  await page.route('**/v1/subscribe/presence**', async route => {
    try {
      const url = new URL(route.request().url())
      const headers = route.request().headers()
      const since = url.searchParams.get('since')
      const hold = Math.min(Number(url.searchParams.get('wait_ms') ?? 0) || 0, holdMs)
      const shimPresence = async () => {
        const r = await fetch(`${url.origin}/v1/companion/presence`, { headers: { authorization: headers['authorization'] ?? '' } })
        return r.ok ? await r.json() : null
      }
      const read = async () => {
        const body = { presence: o.presence ? await o.presence() : await shimPresence(), pet: o.pet ? await o.pet() : null }
        const key = JSON.stringify(body)
        if (key !== lastKey) { lastKey = key; cursor++ }
        return { cursor, ...body }
      }
      let reply = await read()
      const deadline = Date.now() + hold
      while (since !== null && Number(since) === reply.cursor && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50)); reply = await read()
      }
      await route.fulfill({ json: reply })
    } catch { await route.abort().catch(() => { /* spec 已经结束 / 页面已经走了:这一份没人要了 */ }) }
  })
}

export const PRESENCE_OK = { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } }
