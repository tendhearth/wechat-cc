/** 工作台专用封装:逐工具权限桥 + 逐字流。通用实现见 acp-agent-provider.ts。 */
import type { AgentProvider } from './agent-provider'
import { createAcpProvider, type AcpProviderBaseOptions } from './acp-agent-provider'

export type AcpWorkbenchProviderOptions = AcpProviderBaseOptions
export { acpNotice } from './acp-agent-provider'
export function createAcpWorkbenchProvider(options: AcpWorkbenchProviderOptions): AgentProvider {
  return createAcpProvider({ ...options, permissions: 'bridge', text: 'append', attachments: 'prompt' })
}
