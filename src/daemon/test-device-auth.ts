/**
 * 测试用:手机路由里「送话给执行者」的写操作只给设备令牌(审计 2026-10-20)。旧测试拿链接令牌一路打到底,
 * 这里帮它们在第一次碰到只给设备的路由时配一次对(配对会用掉链接令牌,调用方要再发一枚)。
 */
import { LINK_ROUTES } from './phone-routes'

/** 链接令牌的路由表里有没有这个路径(不分方法:门只按路径挡,方法不对交给处理器回 405)。 */
export const linkCannot = (path: string) => { const p = path.split('?')[0]; return ![...LINK_ROUTES].some(k => k.slice(k.indexOf(' ') + 1) === p) }

export async function pairDevice(base: string, link: string): Promise<string> {
  const r = await fetch(`${base}/set/api/pair?t=${encodeURIComponent(link)}`, { method: 'POST' })
  const body = await r.json() as { device_token?: string }
  if (!body.device_token) throw new Error('pair failed in test')
  return body.device_token
}
