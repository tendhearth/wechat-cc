// Authorized launcher for hearth's wechat federated source. Mints a short-lived
// admin-tier token via POST /v1/federation/mint (operator token), then serves a
// SLIM stdio MCP exposing ONLY federated_query — no other wechat/admin tool.
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js' // match main.ts's import
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createInternalApiClient, type InternalApiClient } from './client'
import { registerFederatedQueryTool } from './tools-federated'

export interface ApiInfo { baseUrl: string; tokenFilePath: string; operatorTokenFilePath: string }

export function readApiInfo(infoPath: string): ApiInfo {
  const j = JSON.parse(readFileSync(infoPath, 'utf8')) as Partial<ApiInfo>
  if (!j.baseUrl || !j.tokenFilePath || !j.operatorTokenFilePath) {
    throw new Error(`internal-api-info.json missing fields at ${infoPath}`)
  }
  return { baseUrl: j.baseUrl, tokenFilePath: j.tokenFilePath, operatorTokenFilePath: j.operatorTokenFilePath }
}

export async function mintAdminToken(baseUrl: string, operatorToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/federation/mint`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`federation mint failed: ${res.status} ${detail.slice(0, 120)}`)
  }
  const j = (await res.json()) as { token?: string }
  if (!j.token) throw new Error('federation mint: no token in response')
  return j.token
}

export function buildFederatedServer(client: InternalApiClient): McpServer {
  const server = new McpServer({ name: 'wechat-federated', version: '0.1.0' }, { capabilities: { tools: {} } })
  registerFederatedQueryTool(server, client)
  return server
}

export async function runFederatedSource(infoPath: string, opts?: { fetchImpl?: typeof fetch }): Promise<void> {
  const info = readApiInfo(infoPath)
  const operatorToken = readFileSync(info.operatorTokenFilePath, 'utf8').trim()
  const adminToken = await mintAdminToken(info.baseUrl, operatorToken, opts?.fetchImpl)
  // The internal-api client's bearer prefers WECHAT_SESSION_TOKEN (carries the
  // admin tier); WECHAT_SESSION_TIER is the non-secret companion. Set both
  // before building the client so federated_query's calls authenticate as admin.
  process.env.WECHAT_SESSION_TOKEN = adminToken
  process.env.WECHAT_SESSION_TIER = 'admin'
  const client = createInternalApiClient({ baseUrl: info.baseUrl, tokenFilePath: info.tokenFilePath })
  const server = buildFederatedServer(client)
  process.stderr.write(`[wechat-federated] ready (base=${info.baseUrl})\n`)
  await server.connect(new StdioServerTransport())
}
