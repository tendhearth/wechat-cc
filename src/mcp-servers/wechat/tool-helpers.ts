/**
 * Shared helpers for the wechat-mcp tool handlers. Extracted from main.ts so
 * tool groups can live in their own files (tools-daemon.ts, …) without each
 * re-implementing the error/logging plumbing. Stdout is the MCP transport —
 * logs go to stderr only.
 */
import { InternalApiError } from './client'

export function logErr(line: string): void {
  process.stderr.write(`[wechat-mcp] ${line}\n`)
}

export function passthroughErrorResult(err: unknown, tool: string): { content: Array<{ type: 'text'; text: string }> } {
  // Surface transport-layer failures as `{error: "..."}` JSON in a text
  // block. Keeps the legacy "tool never throws" promise that the
  // in-process versions enforced — agent sees a structured failure
  // result, not an MCP exception.
  //
  // STDERR log gets only status + a recognized error code.
  // — Phase 4 polish. The downstream JSON returned to the agent still
  // carries the full detail; we just don't spam channel-log readers
  // with redacted-feeling response bodies.
  logErr(`${tool} transport failed: ${formatErrorShort(err)}`)
  return { content: [{ type: 'text', text: JSON.stringify({ error: formatError(err) }) }] }
}

export function formatError(err: unknown): string {
  if (err instanceof InternalApiError) {
    return `internal-api ${err.status}: ${JSON.stringify(err.body).slice(0, 200)}`
  }
  return err instanceof Error ? err.message : String(err)
}

export function formatErrorShort(err: unknown): string {
  // Neither a body.error string nor a transport Error.message is trusted log
  // content. Only known codes may cross into daemon stderr; paths may also
  // contain private search terms or credentials in their query parameters.
  if (err instanceof InternalApiError) {
    const code = err.body && typeof err.body === 'object' && 'error' in err.body ? err.body.error : undefined
    return `internal-api ${err.status} ${typeof code === 'string' && LOG_ERROR_CODES.has(code) ? code : 'unknown_error'}`
  }
  return 'transport error'
}

const LOG_ERROR_CODES = new Set([
  'unauthorized', 'route_not_allowed', 'not_found', 'invalid_request', 'malformed_json',
  'internal_error', 'module_off', 'module_degraded', 'module_starting',
  'social_not_wired', 'delegate_not_wired',
])
