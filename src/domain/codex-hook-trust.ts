export type CodexTrustState = 'untrusted' | 'trusted' | 'changed'
export interface CodexHookTrust { state: CodexTrustState; evidence: 'config' | 'invocation' | 'none'; disabled?: boolean; version?: string | null }

export function codexTrustMessage(trust: CodexHookTrust): string {
  if (trust.state === 'trusted') return 'Codex 已连接，开工时也知道 CC 记下的项目近况。'
  if (trust.disabled) return 'Codex 的连接被关了：在 Codex 里输入 /hooks，启用并信任 wechat-cc；如果仍未连接，请检查 Codex 是否关闭了这项连接。'
  return trust.state === 'changed'
    ? 'Codex 需要重新确认一次：在 Codex 里输入 /hooks，审阅并信任 wechat-cc —— 之后 Codex 开工时也知道项目近况。'
    : 'Codex 还差一步：在 Codex 里输入 /hooks，审阅并信任 wechat-cc —— 之后 Codex 开工时也知道项目近况。'
}
