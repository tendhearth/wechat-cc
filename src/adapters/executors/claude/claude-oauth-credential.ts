/**
 * 本机 Claude Code 的 OAuth 凭据(macOS 钥匙串,读不到再读 `~/.claude/.credentials.json`)—— 订阅额度监视器用它问 usage 接口。
 * 这是系统边界(读的是开发者 / 主人自己的账号凭据),单独一个文件:e2e 的 harness 在这里换成「没有凭据」,
 * 测试就不会拿开发机上的真凭据去连 api.anthropic.com(真机形状沙盒 #736 发现的)。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from '../../../lib/runtime/process'
import { readClaudeOAuthToken } from '../../../domain/subscription-usage'

export function readLocalClaudeOAuth(): { token: string; plan: string | null } | null {
  return readClaudeOAuthToken({
    platform: process.platform,
    keychain: () => spawnSync(['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w']).stdout.toString(),
    readFile: () => readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'),
    now: Date.now,
  })
}
