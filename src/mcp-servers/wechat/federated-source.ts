// Authorized launcher for hearth's wechat federated source. Mints a short-lived
// admin-tier token via POST /v1/federation/mint (operator token), then serves a
// SLIM stdio MCP exposing ONLY federated_query — no other wechat/admin tool.
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js' // match main.ts's import
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createInternalApiClient, type InternalApiClient } from './client'
import { registerFederatedQueryTool } from './tools-federated'
import { readJsonFile } from '../../lib/read-json-file'

export interface ApiInfo { baseUrl: string; tokenFilePath: string; operatorTokenFilePath: string }

export function readApiInfo(infoPath: string): ApiInfo {
  const j = readJsonFile(infoPath) as Partial<ApiInfo>
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
  // This process is intentionally short-lived: hearth's federated client spawns
  // it PER QUERY (connect → one federated_query → close in a finally), so the
  // minted admin token is used within seconds. The mint's 5-minute TTL
  // (routes-federation.ts) is a LEAK-BOUND safety, not a live-refresh trigger —
  // we deliberately do not refresh it. If this is ever adapted into a long-lived /
  // persistent source (a spawn serving queries for minutes), it MUST add token
  // refresh (re-mint before the TTL expires and update WECHAT_SESSION_TOKEN),
  // or federated_query will 401 once the token expires.
  //
  // The internal-api client's bearer prefers WECHAT_SESSION_TOKEN (carries the
  // admin tier); WECHAT_SESSION_TIER is the non-secret companion. Setting these
  // mutates process-global env, which is safe here only because this process is
  // a dedicated single-purpose CLI (spawned fresh per query, nothing else in it
  // reads/writes these vars) — set both before building the client so
  // federated_query's calls authenticate as admin.
  process.env.WECHAT_SESSION_TOKEN = adminToken
  process.env.WECHAT_SESSION_TIER = 'admin'
  // fetchImpl is threaded through to the internal-api client too (not just the
  // mint call) so a future test can mock both HTTP paths with one injection.
  // createInternalApiClient does support this (see client.ts's
  // InternalApiClientOptions.fetchImpl); the production path (opts omitted)
  // is unaffected — createInternalApiClient falls back to global fetch itself.
  const client = createInternalApiClient({
    baseUrl: info.baseUrl,
    tokenFilePath: info.tokenFilePath,
    ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })
  const server = buildFederatedServer(client)
  process.stderr.write(`[wechat-federated] ready (base=${info.baseUrl})\n`)
  await server.connect(new StdioServerTransport())
}
