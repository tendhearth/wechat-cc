/**
 * 壳页遇到分享链接(令牌 s+64hex,p=/share):只用链接里的令牌,配对过的手机也不换成设备令牌;
 * 文案对着「被请来的人」说。直接在假 DOM 里跑 relay/pset.src.html 的那段 script。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./pset.src.html', import.meta.url), 'utf8')
// 壳页 script 自己的字符串里也有 <script>:从占位注释那一处切。
const SCRIPT = SRC.slice(SRC.indexOf('/*@@CCP@@*/'), SRC.lastIndexOf('</script>'))

type Outcome = { token: string | null; path: string | null; hand: string; msg: string; removed: string[] }

async function run(hash: string, stored: Record<string, string>, reply: { status?: number; error?: string }): Promise<Outcome> {
  const els = { msg: { textContent: '' }, hand: { textContent: '随身 CC' } } as Record<'msg' | 'hand', { textContent: string }>
  const removed: string[] = []
  const out: Outcome = { token: null, path: null, hand: '', msg: '', removed }
  const store = { ...stored }
  const CCP = {
    makeProtocolClient(o: { token: string }) {
      out.token = o.token
      return {
        close() {},
        request(r: { path: string }) {
          out.path = r.path
          return reply.error ? Promise.reject(new Error(reply.error)) : Promise.resolve({ status: reply.status ?? 200, text: () => '<html><script></script></html>' })
        },
      }
    },
  }
  const sandbox = {
    location: { hash, host: 'relay.test' },
    localStorage: { getItem: (k: string) => store[k] ?? null, removeItem: (k: string) => { removed.push(k); delete store[k] } },
    document: { getElementById: (id: string) => els[id as 'msg'], querySelector: (q: string) => (q === '.hand' ? els.hand : null), open() {}, write() {}, close() {} },
    WebSocket: class {}, CCP, setTimeout: () => 0, clearTimeout: () => {},
  }
  new Function(...Object.keys(sandbox), SCRIPT)(...Object.values(sandbox))
  await new Promise(r => setTimeout(r, 0))
  out.hand = els.hand.textContent; out.msg = els.msg.textContent
  return out
}

const SHARE_T = 's' + 'ab'.repeat(32)
const DEVICE = { deviceToken: 'device-token-of-this-phone', deviceTokenId: 'r1' }
const shareHash = `#id=r1&t=${SHARE_T}&p=%2Fshare`

describe('pset 壳页 × 分享链接', () => {
  it('配对过的手机打开分享链接:用的是链接里的分享令牌,不是设备令牌,也不动本机存的配对', async () => {
    const o = await run(shareHash, DEVICE, { status: 200 })
    expect(o.token).toBe(SHARE_T)
    expect(o.path).toBe(`/share?t=${SHARE_T}`)
    expect(o.removed).toEqual([])
  })

  it('分享链接被关掉 / 过期:对着被请来的人说,不叫人回微信找 CC', async () => {
    const o = await run(shareHash, {}, { status: 401 })
    expect(o.hand).toBe('有人请你看一件事')
    expect(o.msg).toBe('这个链接已经关掉或过期了，找发给你的人再要一个')
    const failed = await run(shareHash, DEVICE, { error: 'auth_failed' })
    expect(failed.msg).toBe('这个链接已经关掉或过期了，找发给你的人再要一个')
    expect(failed.removed).toEqual([])
  })

  it('分享链接遇到对方电脑不在线:说对方的电脑', async () => {
    expect((await run(shareHash, {}, { error: 'daemon_offline' })).msg).toBe('对方的电脑现在没开着，晚点再打开这个链接')
  })

  it('普通配对链接行为不变:有设备令牌就用设备令牌', async () => {
    const o = await run('#id=r1&t=shortlived&p=%2Fm', DEVICE, { status: 200 })
    expect(o.token).toBe('device-token-of-this-phone')
    expect(o.hand).toBe('随身 CC')
    const expired = await run('#id=r1&t=shortlived', {}, { status: 401 })
    expect(expired.msg).toBe('这个链接已经用过或过期了，回微信跟 CC 再要一个')
  })
})
