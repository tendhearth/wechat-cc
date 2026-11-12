import type {SpawnContext} from '../../ports/agent-provider'
import type {McpStdioSpec} from './mcp-stdio-spec'

/** Only daemon-built specs may enter this seam; native configuration is excluded first. */
export type MatterMcpFactory=(context:Pick<SpawnContext,'mcpEnv'>)=>McpStdioSpec|null
export const MATTER_TOOL_NAMES=['matter_notes','matter_note'] as const
export const isMatterMcpTool=(name:string):boolean=>MATTER_TOOL_NAMES.some(tool=>name===`mcp__matter__${tool}`)
