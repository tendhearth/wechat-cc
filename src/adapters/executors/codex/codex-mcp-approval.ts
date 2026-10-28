import { isDeepStrictEqual } from 'node:util'
import { toolInputPreview } from '../../../domain/workbench/tool-input-preview'

type Value = Record<string, unknown>
const object = (value: unknown): value is Value => !!value && typeof value === 'object' && !Array.isArray(value)
const name = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 150 && !/[\u0000-\u001f\u007f]/.test(value)

/** Native 0.153.4 tool approvals use an empty form and privileged metadata.
 * Bind the request to an observed invocation, never infer a tool from prose. */
export function codexMcpApproval(params: Value, items: Iterable<Value>, completed: Set<string>, enabled: Set<string>): { tool: string; description: string; input: Record<string, unknown> } | null {
  const meta = params._meta, schema = params.requestedSchema
  if (!name(params.serverName) || !enabled.has(params.serverName) || params.mode !== 'form' ||
      !object(meta) || meta.codex_approval_kind !== 'mcp_tool_call' ||
      !object(schema) || schema.type !== 'object' || !object(schema.properties) || Object.keys(schema.properties).length ||
      Object.keys(schema).some(key => !['type', 'properties', 'required'].includes(key)) ||
      (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length))) return null
  const candidates = [...items].filter(item => item.type === 'mcpToolCall' && item.server === params.serverName &&
    name(item.id) && !completed.has(item.id) && name(item.tool) &&
    (meta.tool_name == null || meta.tool_name === item.tool) && isDeepStrictEqual(item.arguments ?? null, meta.tool_params ?? null))
  if (candidates.length !== 1) return null
  const item = candidates[0]!
  try {
    const argumentsPreview = toolInputPreview(item.arguments ?? {}, true)
    if (argumentsPreview === null) return null
    const description = `MCP server: ${params.serverName}\nTool: ${item.tool}\nArguments:\n${argumentsPreview}\nApprove this invocation only.`
    if (description.length > 20_000) return null
    // input:对上的那次调用的参数(对话侧按档位分类要用;工作台不转给审批卡)。
    return { tool: `mcp__${params.serverName}__${item.tool}`, description, input: object(item.arguments) ? item.arguments : {} }
  } catch { return null }
}

/** Approval configuration and elicitation were verified together at this floor. */
export function supportsCodexMcpApproval(userAgent: unknown): boolean {
  if (typeof userAgent !== 'string') return false
  const match = userAgent.match(/^[^/\r\n]+\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/)
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number]
  return major > 0 || minor > 153 || (minor === 153 && patch >= 4)
}
