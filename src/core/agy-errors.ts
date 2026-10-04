/**
 * agy(Antigravity CLI)边界的错误分类(arch backlog #4 第 2 步;样本见
 * provider-error-shapes.md 的 agy 一节 —— 全部是真机采集,agy 没有沙箱诱发)。
 *
 * agy 只给 `result status=ERROR: <一句话>`,没有任何结构。这里只认它自己(Go 写的)
 * 固定的几种说法,在边界映射成码:
 *
 *   · 红线 B(owner 2026-08-27 定、2026-09-02 推广为通则):
 *     `authentication failed or timed out` **固定**判 `network`(瞬时)—— owner 确认过
 *     agy 能登录,这句其实是网络 / 超时。像 auth 又像瞬时的,一律判瞬时。
 *   · Go 的网络措辞:`no such host`、`<url>": EOF`、`TLS handshake timeout`、
 *     `i/o timeout`、`connection refused / reset`、`There was a network issue` ⇒ network。
 *   · `<N> Internal Server Error` 这类 HTTP 5xx ⇒ server_error;429 / RESOURCE_EXHAUSTED ⇒ rate_limited。
 *   · 认不出 ⇒ undefined(不发码,下游走旧的文本回退)。agy 这里**刻意不产认证码**:
 *     真机上从没见过一句明确的「凭证无效」,而唯一像认证的那句按红线 B 是瞬时。
 */
import type { ProviderErrorCode } from '../lib/provider-error-code'
import { isConnectFailure } from '../lib/net-errors'

const AMBIGUOUS = /authentication failed or timed out/i
const GO_NETWORK = /no such host|": EOF\b|TLS handshake timeout|i\/o timeout|connection (?:refused|reset)|network is unreachable|There was a network issue|context deadline exceeded|Client\.Timeout/i

export function agyErrorCode(message: string): ProviderErrorCode | undefined {
  const m = message ?? ''
  if (!m.trim()) return undefined
  if (AMBIGUOUS.test(m)) return 'network' // 红线 B
  if (GO_NETWORK.test(m) || isConnectFailure(m)) return 'network'
  if (/\b429\b|RESOURCE_EXHAUSTED|rate limit/i.test(m)) return 'rate_limited'
  if (/\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.test(m)) return 'server_error'
  return undefined
}
