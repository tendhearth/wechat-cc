/**
 * 找主人装的那个 CLI —— 与 provider 注册时找的是同一个(bootstrap/providers.ts):
 * claude = `CLAUDE_CODE_EXECUTABLE` 或 PATH;codex = find-codex-binary(PATH / nvm / standalone 兜底);
 * cursor = agent-config 的 cursorAgentBin 或 PATH;agy = agyBin 或 PATH。
 * SDK 自带的 claude(node_modules 里)在 layout.ts 里认成 bundled,不归自动升级管。
 */
import { existsSync } from 'node:fs'
import { findOnPath } from '../../lib/util'
import { findCodexBinary } from '../../lib/find-codex-binary'
import type { CliId } from './specs'

export interface LocateOpts { cursorAgentBin?: string; agyBin?: string; env?: NodeJS.ProcessEnv }

export function defaultLocate(id: CliId, opts: LocateOpts = {}): string | null {
  const env = opts.env ?? process.env
  switch (id) {
    case 'claude': {
      const e = env.CLAUDE_CODE_EXECUTABLE
      if (e && existsSync(e)) return e
      return findOnPath('claude')
    }
    case 'codex': return findCodexBinary()
    case 'cursor': return opts.cursorAgentBin ?? findOnPath('cursor-agent')
    case 'agy': return opts.agyBin ?? findOnPath('agy')
  }
}
