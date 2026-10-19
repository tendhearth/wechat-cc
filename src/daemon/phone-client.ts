import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * phone-client.ts — 手机这一头到底是原生 App 还是浏览器 /m(2026-10-19,一件事的出生地)。
 *
 * 只看 daemon 自己观察到的传输,不看请求里任何客户端自报的字段:
 *   - 原生 App(apps/app)只走 packages/protocol 的客户端,握手带 v:[1,2],daemon 回 v2 ⇒ 每个请求都是
 *     中继 v2 的密封帧,由 tunnel-v2-stream 在 daemon 进程里合成 Request。那里调 `markAppRequest`,
 *     记进一个只有 daemon 代码碰得到的 WeakSet —— 请求头 / 查询参数都伪造不了它。
 *   - 浏览器 /m 页(apps/mobile)要么局域网直连 Bun.serve,要么走 v1 隧道(transport.js 握手不带 v);
 *     中继上的壳页(relay/pset)同样是 v1。这两条进来的 Request 都不在集合里 ⇒ web。
 * 两边拿到的都是同一种设备令牌(浏览器也会 /set/api/pair),所以令牌的 origin('device' / 'link')分不开它们;
 * 分得开的是这条流说的协议。
 *
 * 面板的 handleRequest 在路由外面包一层 `withPhoneClient`:下游(建一件事、主人对话首建)用
 * `currentPhoneClient()` 取,不必把它一层层传进各个接口。只在手机面板的请求里有值,别处一律 null。
 */
export type PhoneClient = 'app' | 'web'

const appRequests = new WeakSet<Request>()
const current = new AsyncLocalStorage<PhoneClient>()

/** tunnel-v2-stream 合成的那个 Request:标记成「原生 App 来的」。只在 daemon 进程里调。 */
export function markAppRequest(req: Request): Request {
  appRequests.add(req)
  return req
}

/** 这个 Request 是从哪种手机客户端来的(只认上面的标记,别的都是浏览器)。 */
export function phoneClientOf(req: Request): PhoneClient {
  return appRequests.has(req) ? 'app' : 'web'
}

/** 在这次请求的处理(含它起的后台 promise)里记住客户端。 */
export function withPhoneClient<T>(client: PhoneClient, fn: () => T): T {
  return current.run(client, fn)
}

/** 当前手机请求的客户端;不在手机面板的请求里 ⇒ null(不知道就不写出生地)。 */
export function currentPhoneClient(): PhoneClient | null {
  return current.getStore() ?? null
}

/** 桌面 / 手机两个表面 → 出生地:桌面就是 desktop;手机看这次请求的传输,不在手机请求里 ⇒ null。 */
export function surfaceOrigin(surface: 'desktop' | 'phone'): 'desktop' | PhoneClient | null {
  return surface === 'desktop' ? 'desktop' : currentPhoneClient()
}
