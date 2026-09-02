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
const LLM_AUTH_RE = /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication/i

function messageOf(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err)
  } catch {
    // Guard against malicious toString() or message property that throws.
    // Classifier must never become a failure vector itself.
    return '<error>'
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
  if (isNetworkish(msg)) {
    return {
      kind: 'network',
      actionable: false,
      title: '网络连接有问题',
      body: '暂时连不上服务器,通常会自行恢复,你不需要做什么。',
    }
  }
  if (LLM_AUTH_RE.test(msg)) {
    return {
      kind: 'llm_auth',
      actionable: true,
      title: '模型登录已失效',
      body: '消息还能收到,但暂时没法生成回复。重新登录一下模型账号即可恢复。',
    }
  }
  return {
    kind: 'unknown',
    actionable: false,
    title: '连接出现问题',
    body: '暂时无法正常工作,恢复后会再通知你。',
  }
}
