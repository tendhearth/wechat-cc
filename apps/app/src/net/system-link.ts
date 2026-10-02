// 系统交给 app 的配对链接(spec 2026-10-01-tendhearth-pairing-ux §6.3)。纯逻辑:不 import react / expo。
// 发布构建只认 https://relay.tendhearth.com/pset…;开发构建再认 staging 主机与 tendhearth://<主机>/pset/#…(D7,给模拟器 / Maestro)。
// 令牌在锚点里,不进路由参数:rewriteSystemPath 把原链接放进这一格,配对页取走即焚。

const PROD = 'relay.tendhearth.com'
const STAGING = 'relay-staging.tendhearth.com'
const SYS_RE = /^(https|tendhearth):\/\/([a-z0-9.-]+)\/pset\/?(#.*)?$/i

export function systemPairLink(url: string, dev: boolean): string | null {
  const m = SYS_RE.exec(url.trim())
  if (!m) return null
  const scheme = m[1]!.toLowerCase()
  const host = m[2]!.toLowerCase()
  if (scheme === 'tendhearth' && !dev) return null
  if (host !== PROD && !(dev && host === STAGING)) return null
  return `https://${host}/pset/${m[3] ?? ''}`
}

let pending: string | null = null
export function setPendingLink(raw: string): void { pending = raw }
export function takePendingLink(): string | null {
  const p = pending
  pending = null
  return p
}
