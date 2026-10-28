/**
 * A2A 的口(架构终态 E5):出站 HTTP 客户端、注册表、exec 的结果。实现在 src/adapters/a2a/;
 * app(委派、乙的 hub / hand、配对)只经这里认它们的形状。只有类型,没有逻辑。
 */
import type { A2AAgentRecord } from '../lib/agent-config'

export interface AgentCard {
  name: string
  description?: string
  version?: string
  /** A2A wire-protocol version; ABSENT on pre-versioning peers ⇒ treat as 1. */
  proto_version?: number
  auth?: { type: string; required: boolean }
  capabilities?: Array<{
    name: string
    description?: string
    endpoint?: string
    method?: string
    request_schema?: unknown
  }>
}

export interface SendRequest {
  url: string
  bearer: string
  body: unknown
}

export interface SendResult {
  ok: boolean
  http_status?: number
  response?: unknown
  error?: string
}

export interface A2AClient {
  fetchAgentCard(baseUrl: string): Promise<AgentCard>
  send(req: SendRequest): Promise<SendResult>
}

/** Subset of A2AAgentRecord that's safe to patch via update(). `id` is the
 *  primary key and can't be changed; `capabilities` is derived from the
 *  Agent Card; `paused` has its own toggle. */
/** `may_exec` 可 patch —— 重新配对(onPair)是一次**新的授权**,不只是换钥匙。
 *  其余安全相关字段仍不可 patch:要改就走 remove + add,免得半路把一条社交
 *  记录悄悄改成一只手。 */
export type A2AAgentPatch = Partial<Pick<A2AAgentRecord, 'name' | 'url' | 'inbound_api_key' | 'outbound_api_key' | 'may_exec'>>

export interface A2ARegistry {
  list(): readonly A2AAgentRecord[]
  get(id: string): A2AAgentRecord | null
  verifyBearer(agentId: string, bearer: string): A2AAgentRecord | null
  add(rec: A2AAgentRecord): void
  remove(id: string): void
  setPaused(id: string, paused: boolean): void
  /** Patch one or more fields on an existing agent. Throws if id not found
   *  or if the resulting record fails validation (e.g. empty key). Returns
   *  the updated record. */
  update(id: string, patch: A2AAgentPatch): A2AAgentRecord
}

export type ExecResult = { ok: true; response: string } | { ok: false; reason: string }
