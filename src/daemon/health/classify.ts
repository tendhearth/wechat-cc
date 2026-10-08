/**
 * classify — 把一个抛出物变成"给主人看的结论"(spec 2026-08-03 §5)。
 *
 * `actionable` 决定通知阈值(3 分钟 vs 30 分钟)与是否重复提醒:
 * 主人能动手的故障不通知就永远不会好,而网络问题他收到也做不了什么。
 *
 * 判定全部是确定性规则 —— LLM 不参与检测,它必须比被监控对象更可靠。
 * 认不出来时一律当"不可操作",宁可晚说,不要用猜测去打扰。
 */
import { isConnectFailure } from '../../lib/net-errors'
import { looksLikeAuthFailure } from '../../lib/auth-failure'
import { providerErrorCodeOf, type ProviderErrorCode } from '../../lib/provider-error-code'
import { log } from '../../lib/log'

export type FailureKind = 'login_taken_over' | 'llm_auth' | 'network' | 'unknown'

export interface FailureClass {
  kind: FailureKind
  /** 主人能不能立刻动手解决。决定 3min/15min 阈值与是否 6 小时重复提醒。 */
  actionable: boolean
  title: string
  body: string
}

// 连接层的措辞收敛在 lib/net-errors(Node 与 Bun 两套);这里只补 TLS/超时
// 这类**不属于「连不上」**的网络症状。此前这条正则漏了 Bun 的
// 「typo in the url or port」,于是一次 Bun 连接失败会被判成「非网络问题」。
const NETWORK_EXTRA_RE = /certificate|tls|ssl|timed out|timeout/i
const isNetworkish = (t: string): boolean => isConnectFailure(t) || NETWORK_EXTRA_RE.test(t)
// 词汇来自 lib/auth-failure(共享词汇表)。此前这里手写的正则**不含
// `auth_failed`** —— 本仓库自己的规范错误码 —— 于是 claude 登录真死时,
// 这个「决定要不要通知主人」的判定给出 unknown/actionable:false。
// 顺序仍然是网络优先:歧义一律归瞬时(owner 2026-09-02 的通则),
// 误报「去重新登录」比多等一轮重试贵得多。

function messageOf(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err)
  } catch {
    // Guard against malicious toString() or message property that throws.
    // Classifier must never become a failure vector itself.
    return '<error>'
  }
}

const NETWORK: FailureClass = {
  kind: 'network',
  actionable: false,
  title: '网络连接有问题',
  body: '暂时连不上服务器,通常会自行恢复,你不需要做什么。',
}
const LLM_LOGIN_EXPIRED: FailureClass = {
  kind: 'llm_auth',
  actionable: true,
  title: '模型登录已失效',
  body: '消息还能收到,但暂时没法生成回复。重新登录一下模型账号即可恢复。',
}
/** 红线 A(owner 2026-10-02 细化):凭证被拒但不是哨兵确认的登录过期 ——
 *  同样要主人动手,但**不说**登录过期 / 重新登录。 */
const LLM_AUTH_REJECTED: FailureClass = {
  kind: 'llm_auth',
  actionable: true,
  title: '模型认证没通过',
  body: '消息还能收到,但模型服务拒绝了凭证(API 返回 401/403),暂时没法生成回复。请检查账号或密钥。',
}
const UNKNOWN: FailureClass = {
  kind: 'unknown',
  actionable: false,
  title: '连接出现问题',
  body: '暂时无法正常工作,恢复后会再通知你。',
}

/** provider 边界已经分好类的失败:只看码,不碰文本(arch backlog #4 第 2 步)。 */
function classifyProviderCode(code: ProviderErrorCode): FailureClass {
  switch (code) {
    case 'auth_failed': return LLM_LOGIN_EXPIRED
    case 'auth_rejected': return LLM_AUTH_REJECTED
    case 'network': case 'server_error': return NETWORK
    // 限流 / 额度 / 坏请求 / 未分类:不是连通性也不是凭证,不该把整条 LLM 链路判坏。
    case 'rate_limited': case 'quota': case 'invalid_request': case 'provider_error': return UNKNOWN
  }
}

export function classifyFailure(err: unknown): FailureClass {
  const msg = messageOf(err)

  if (/errcode=-14/.test(msg)) {
    return {
      kind: 'login_taken_over',
      actionable: true,
      title: '微信登录已失效',
      body: '这个微信账号在别处被重新绑定了。打开 wechat-cc 桌面端重新扫码即可恢复。',
    }
  }
  // 有码就只看码;码缺失(还没迁移的 provider)才回退到下面的文本判定。
  const code = providerErrorCodeOf(err)
  // 返回副本:常量是共享的,调用方改了它不该影响下一次判定。
  if (code) return { ...classifyProviderCode(code) }
  const fallback = isNetworkish(msg) ? NETWORK : looksLikeAuthFailure(msg) ? LLM_LOGIN_EXPIRED : UNKNOWN
  noteFallback(fallback.kind, msg)
  return { ...fallback }
}

/**
 * 文本回退的留痕(arch backlog #4 第 3 步的前提,2026-10-06):roadmap 说「真机跑一段确认码覆盖够了,再删文本回退」,
 * 可是回退什么时候真被用到原本没有任何记录。这里每次没码、靠文本下结论时记一行 `ERROR_FALLBACK`:结论 + 错误开头
 * 80 字(数字抹成 #,不同次的端口 / 请求号不会变成不同的行)。同一行一小时内只记一次。只进本机日志。
 */
const FALLBACK_SEEN = new Map<string, number>()
export function noteFallback(kind: FailureKind, msg: string, now = Date.now(), sink: (line: string) => void = line => log('ERROR_FALLBACK', line)): void {
  const shape = msg.replace(/\s+/g, ' ').replace(/\d+/g, '#').slice(0, 80)
  const key = `${kind}|${shape}`
  const last = FALLBACK_SEEN.get(key)
  if (last !== undefined && now - last < 3_600_000) return
  if (FALLBACK_SEEN.size > 500) FALLBACK_SEEN.clear()
  FALLBACK_SEEN.set(key, now)
  sink(`no provider code → ${kind}: ${shape}`)
}
