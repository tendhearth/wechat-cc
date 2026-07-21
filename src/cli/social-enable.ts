/**
 * wechat-cc social enable — one-toggle 觅食台 social onboarding.
 *
 * Flips `social_enabled: true` and fills in the two other social-boot
 * settings (`social_disclosure_policy`, `mailbox_relays`) with defaults
 * ONLY when absent — an existing operator-set value is never overwritten.
 *
 * Persistence copies persistSelfAgentId's (src/core/self-agent-id.ts)
 * read-modify-write raw-file idiom verbatim: read the raw JSON off disk,
 * set only the keys this command owns, atomic tmp+rename at 0600. This is
 * load-bearing — saveAgentConfig serializes the full MODELED AgentConfig
 * and would silently drop any unmodeled/legacy keys already on disk
 * (see self-agent-id.ts's doc comment for the same invariant).
 *
 * No `disable` subcommand — turning social off is an operator-config edit,
 * not a one-toggle onramp; this command only ever moves forward.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_SOCIAL_DISCLOSURE_POLICY =
  '可以说我的兴趣、想找的同好或资源;不可透露我的真实姓名、住址、电话或任何联系方式,也不提及除我和收件方以外的任何第三方。'
export const DEFAULT_MAILBOX_RELAYS = ['https://brain.youdamaster.cc/mailbox']

function readRawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function cmdSocialEnable(stateDir: string, opts: { status: boolean }): void {
  const path = join(stateDir, 'agent-config.json')
  const raw = readRawConfig(path)

  if (opts.status) {
    console.log(`social_enabled: ${raw.social_enabled === true}`)
    console.log(`social_disclosure_policy: ${typeof raw.social_disclosure_policy === 'string' ? raw.social_disclosure_policy : '(未设置,启用后使用默认策略)'}`)
    const relays = Array.isArray(raw.mailbox_relays) ? raw.mailbox_relays : []
    console.log(`mailbox_relays: ${relays.length > 0 ? relays.join(', ') : '(未设置,启用后使用默认中继)'}`)
    return
  }

  const changed: string[] = []
  if (raw.social_enabled !== true) changed.push('social_enabled')
  raw.social_enabled = true

  if (raw.social_disclosure_policy == null) {
    raw.social_disclosure_policy = DEFAULT_SOCIAL_DISCLOSURE_POLICY
    changed.push('social_disclosure_policy(默认)')
  }

  if (!Array.isArray(raw.mailbox_relays) || raw.mailbox_relays.length === 0) {
    raw.mailbox_relays = DEFAULT_MAILBOX_RELAYS
    changed.push('mailbox_relays(默认)')
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)

  console.log(changed.length > 0 ? `已更新: ${changed.join(', ')}` : '社交已开启(设置未变)')
  console.log('社交已开启,重启 daemon 生效(wechat-cc restart 或桌面重启)')
}
