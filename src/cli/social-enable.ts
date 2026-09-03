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
 * 2026-08-31 —— 两处变化,都是为了"朋友能被拉来测试":
 *
 * 1. 逻辑抽成与 console 无关的 `applySocialSwitch`,给 HTTP 路由复用。此前
 *    桌面端三处入口(配对面板、笔友信箱、寄信)在社交未启用时【只会说
 *    「先在命令行运行 wechat-cc social enable」】—— 一个桌面产品把人踢回
 *    终端,被朋友拉来试的人基本必然卡死在这一步。
 * 2. 新增关闭能力。原注释写过"不做 disable —— 关社交是运维改配置,不是一键
 *    上手的一部分";这条被有意推翻:开关既然成了产品里的按钮,就必须能关,
 *    否则用户被单向门锁住。关闭只翻 social_enabled,**保留**披露策略与中继,
 *    这样再开启时不用重填。
 */
import { existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'

export const DEFAULT_SOCIAL_DISCLOSURE_POLICY =
  '可以说我的兴趣、想找的同好或资源;不可透露我的真实姓名、住址、电话或任何联系方式,也不提及除我和收件方以外的任何第三方。'
export const DEFAULT_MAILBOX_RELAYS = ['https://cc.tendhearth.com/mailbox']

function readRawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return readJsonFile(path) as Record<string, unknown>
  } catch {
    return {}
  }
}

export interface SocialSwitchResult {
  enabled: boolean
  /** 本次真正落盘的改动项(人话),没变则为空数组 —— 调用方据此决定说什么。 */
  changed: string[]
}

/**
 * 翻转社交总开关并落盘,返回改了什么。纯函数式(不打印、不退出),CLI 与
 * `POST /v1/social/enable` 共用这一份。
 *
 * 落盘沿用 persistSelfAgentId 的 read-modify-write 生写法:读原始 JSON、
 * 只改本命令拥有的键、tmp+rename 原子写 0600。这是**载重的** —— saveAgentConfig
 * 会按建模后的 AgentConfig 全量序列化,静默丢掉磁盘上任何未建模/遗留的键。
 */
export function applySocialSwitch(stateDir: string, enabled: boolean): SocialSwitchResult {
  const path = join(stateDir, 'agent-config.json')
  const raw = readRawConfig(path)
  const changed: string[] = []

  if (raw.social_enabled !== enabled) changed.push('social_enabled')
  raw.social_enabled = enabled

  // 只有开启时才补默认值;关闭时保留它们(见文件头第 2 条)。
  if (enabled) {
    if (raw.social_disclosure_policy == null) {
      raw.social_disclosure_policy = DEFAULT_SOCIAL_DISCLOSURE_POLICY
      changed.push('social_disclosure_policy(默认)')
    }
    if (!Array.isArray(raw.mailbox_relays) || raw.mailbox_relays.length === 0) {
      raw.mailbox_relays = DEFAULT_MAILBOX_RELAYS
      changed.push('mailbox_relays(默认)')
    }
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  return { enabled, changed }
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

  const { changed } = applySocialSwitch(stateDir, true)

  console.log(changed.length > 0 ? `已更新: ${changed.join(', ')}` : '社交已开启(设置未变)')
  console.log('社交已开启,重启 daemon 生效(wechat-cc restart 或桌面重启)')
}
