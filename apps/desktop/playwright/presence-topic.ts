import type { Page, Request } from '@playwright/test'

type Source = () => unknown | Promise<unknown>

/**
 * 桌宠订的 presence 主题(S5,GET /v1/subscribe/presence)在 spec 里的替身:以前各 spec 分别 route
 * `/v1/companion/presence` 和 `/v1/companion/pet`,现在两半由这里拼成一份。没给的那一半照旧从 shim 拿
 * (presence 读 shim 的 /v1/companion/presence,按 demo.seed;pet 为 null —— 演示模式没有「在做什么」)。
 *
 * 像 daemon 一样:内容变了 cursor 才加一;since 和现在的一样就挂着(每 20ms 重读一次两个源,变了马上回),
 * 挂到 wait_ms 的一半才原样回。按**页面的钟**算(用了 page.clock 的 spec 里是假时间):页面那头的请求超时
 * (AbortSignal.timeout)也走假钟,挂得比它久就会被页面自己掐掉、桌宠掉成「联系不上」。真时钟的 spec 再加一个
 * holdMs 上限(默认 2 秒),好让「再来一份」等得不久。桌面收到 cursor 没变的那份不会重画。
 *
 * `parked(request)`:这条请求正挂着等变化(还没有要回的新东西)。按步走假钟的 spec 用它区分「挂着的长轮询」
 * 和「该落地的回答」—— 前者不是轮询,不用等它。
 * 不用 route.fetch:挂着的回调在 spec 结束以后还会跑,route.fetch 那时会抛「Test ended」,把下一个 spec 也弄红。
 */
export async function routePresenceTopic(page: Page, o: { presence?: Source; pet?: Source; holdMs?: number }): Promise<{ parked: (request: Request) => boolean }> {
  let cursor = 1, lastKey = ''
  const holdMs = o.holdMs ?? 2_000
  const parked = new Set<Request>()
  const pageNow = () => page.evaluate(() => Date.now())
  await page.route('**/v1/subscribe/presence**', async route => {
    const request = route.request()
    try {
      const url = new URL(request.url())
      const headers = request.headers()
      const since = url.searchParams.get('since')
      const wait = Number(url.searchParams.get('wait_ms') ?? 0) || 0
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
      if (since !== null && Number(since) === reply.cursor && wait > 0) {
        parked.add(request)
        // 页面那头的超时是 wait_ms + 5 秒(假钟):回在 wait_ms 的一半,按步快进的假钟也赶不上它。
        const realDeadline = Date.now() + holdMs, pageDeadline = (await pageNow()) + wait / 2
        while (Number(since) === reply.cursor && Date.now() < realDeadline && (await pageNow()) < pageDeadline) {
          await new Promise(r => setTimeout(r, 20)); reply = await read()
        }
        parked.delete(request)
      }
      await route.fulfill({ json: reply })
    } catch {
      parked.delete(request)
      await route.abort().catch(() => { /* spec 已经结束 / 页面已经走了:这一份没人要了 */ })
    }
  })
  return { parked: request => parked.has(request) }
}

export const PRESENCE_OK = { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } }
