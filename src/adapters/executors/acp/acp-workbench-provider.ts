/** 工作台专用封装:逐工具权限桥 + 逐字流。通用实现见 acp-agent-provider.ts。 */
import type { AgentProvider } from '../../../ports/agent-provider'
import { createAcpProvider, type AcpProviderBaseOptions } from './acp-agent-provider'
import type {MatterMcpFactory} from '../matter-mcp'

export type AcpWorkbenchProviderOptions = AcpProviderBaseOptions & {matterMcp?:MatterMcpFactory}
export { acpNotice } from './acp-agent-provider'
export function createAcpWorkbenchProvider(options: AcpWorkbenchProviderOptions): AgentProvider {
  return createAcpProvider({ ...options, permissions: 'bridge', text: 'append', attachments: 'prompt',mcpServers:context=>{
    const spec=options.matterMcp?.(context)
    context.reportMatterTools?.(!!spec)
    return spec?[{name:'wechat-cc-matter',command:spec.command,args:spec.args??[],env:Object.entries(spec.env??{}).map(([name,value])=>({name,value}))}]:[]
  } })
}
