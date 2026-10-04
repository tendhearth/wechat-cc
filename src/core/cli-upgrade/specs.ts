/**
 * cli-upgrade/specs — 四个外部 agent CLI 各自的「怎么认版本、怎么查最新、用谁升级、怎么退回」。
 *
 * 主人 2026-10-04 拍板:wechat-cc 全自动(默认开)把 Claude Code / Codex / cursor-agent / agy
 * 保持最新,并且自动发现输出格式 / 协议不兼容。规矩(见 docs/maintainer/cli-auto-upgrade.md):
 *
 *  - 升级只用 CLI **自己的官方升级器**(`<bin> update`),不自己下载、不替换二进制;
 *  - 查最新只是**探测**:CLI 没有「只查不装」的开关时,才读官方发布元数据(npm dist-tags、
 *    Cursor 官方安装脚本里写死的版本号);agy 两样都没有 ⇒ 最新版本未知,定时检查直接跑它自己的升级器
 *    (升级器本身就是「有新的才装」);
 *  - 版本号判不出兼容不兼容(codex 2026-09-09 定案)⇒ 升级后**真跑一轮自检**才算数,不按版本号拒。
 */

export type CliId = 'claude' | 'codex' | 'cursor' | 'agy'
export const CLI_IDS: readonly CliId[] = ['claude', 'codex', 'cursor', 'agy']

export type LatestSource =
  | { kind: 'npm'; pkg: string }
  /** Cursor 官方安装脚本(`curl https://cursor.com/install | bash` 的那一份)里写死的版本目录。 */
  | { kind: 'cursor-install-script'; url: string }
  /** 没有只读的最新版本来源:定时检查直接跑官方升级器,升级器自己判有没有新版。 */
  | { kind: 'none' }

export interface CliSpec {
  id: CliId
  /** provider registry 里的 id(selftest chat / workbench 用它)。 */
  providerId: string
  /** 给主人看的名字。 */
  label: string
  /** PATH 上的可执行文件名。 */
  bin: string
  /** 官方升级器参数:`<bin> ...updateArgs`。 */
  updateArgs: readonly string[]
  /** 官方「装指定版本」的参数(没有就 undefined):退回时本地没留旧版本才用。 */
  installVersionArgs?: (version: string) => string[]
  latest: LatestSource
  /** 版本号长什么样:semver(x.y.z)还是 Cursor 的 `YYYY.MM.DD-<hash>`。 */
  versionKind: 'semver' | 'cursor-date'
  /** 升级后要不要再跑 `selftest workbench`(工作台执行者)。 */
  workbench: boolean
  /** 对话自检里 wechat MCP 的 ping 工具调用是不是必过项。agy 的 MCP 真连还没在真机验过,不能拿它判「升级坏了」。 */
  requireToolInChat: boolean
}

export const CLI_SPECS: Readonly<Record<CliId, CliSpec>> = {
  claude: {
    id: 'claude', providerId: 'claude', label: 'Claude Code', bin: 'claude',
    updateArgs: ['update'],
    // `claude install <version>`:官方安装器,支持 stable / latest / 具体版本号。
    installVersionArgs: (v) => ['install', v],
    latest: { kind: 'npm', pkg: '@anthropic-ai/claude-code' },
    versionKind: 'semver', workbench: true, requireToolInChat: true,
  },
  codex: {
    id: 'codex', providerId: 'codex', label: 'Codex', bin: 'codex',
    updateArgs: ['update'],
    latest: { kind: 'npm', pkg: '@openai/codex' },
    versionKind: 'semver', workbench: true, requireToolInChat: true,
  },
  cursor: {
    id: 'cursor', providerId: 'cursor', label: 'Cursor', bin: 'cursor-agent',
    updateArgs: ['update'],
    latest: { kind: 'cursor-install-script', url: 'https://cursor.com/install' },
    versionKind: 'cursor-date', workbench: true, requireToolInChat: true,
  },
  agy: {
    id: 'agy', providerId: 'agy', label: 'agy', bin: 'agy',
    updateArgs: ['update'],
    latest: { kind: 'none' },
    // agy 是免审执行者:工作台自检的「权限往返」那一项对它不成立,只跑对话自检。
    versionKind: 'semver', workbench: false, requireToolInChat: false,
  },
}

/** provider id → CLI id(只有这四家是外部 CLI;openai / gemini 不归这里管)。 */
export function cliIdForProvider(providerId: string): CliId | null {
  return (CLI_IDS as readonly string[]).includes(providerId) ? providerId as CliId : null
}

export function isCliId(x: unknown): x is CliId {
  return typeof x === 'string' && (CLI_IDS as readonly string[]).includes(x)
}
