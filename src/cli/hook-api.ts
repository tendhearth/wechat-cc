// Small, shared hook dependencies: no event relay, machine probes or CLI registry.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'

export const DAEMON_CHILD_ENV = 'WECHAT_CC_DAEMON_CHILD'
export function shouldSkipHook(env: Record<string, string | undefined>): boolean {
  return env[DAEMON_CHILD_ENV] === '1'
}

/** 读 `<stateDir>/internal-api-info.json`(与 `wechat-cc agent` 同源)拿 baseUrl + FILE token。 */
export function readApiInfo(stateDir: string): { baseUrl: string; token: string } | { reason: string } {
  const infoPath = join(stateDir, 'internal-api-info.json')
  if (!existsSync(infoPath)) return { reason: 'daemon_not_running' }
  let info: { baseUrl?: string; tokenFilePath?: string }
  try { info = readJsonFile(infoPath) } catch { return { reason: 'info_malformed' } }
  if (!info.baseUrl || !info.tokenFilePath) return { reason: 'info_incomplete' }
  try { return { baseUrl: info.baseUrl, token: readFileSync(info.tokenFilePath, 'utf8').trim() } }
  catch { return { reason: 'token_unreadable' } }
}
