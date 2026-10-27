/**
 * fake-credentials.ts — 本机账号凭据是系统边界:e2e 里一律「没有凭据」。
 *
 * 订阅额度监视器(features/workbench/wire.ts)读本机 Claude Code 的 OAuth 凭据去问 usage 接口;不换掉的话,
 * 开发机上跑 e2e 会拿开发者自己的凭据真连 api.anthropic.com(真机形状沙盒 #736 的网络围栏抓到的)。
 * harness 里副作用 import,跟 fake-media 一样,各测试文件不用自己登记。
 */
import { vi } from 'vitest'

vi.mock('../../adapters/executors/claude/claude-oauth-credential', () => ({
  readLocalClaudeOAuth: () => null,
}))
