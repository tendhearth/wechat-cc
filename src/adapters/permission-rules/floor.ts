/**
 * floor.ts — 固定红线(规则和模型都改不了)与低风险分类(初审只在这里面跑)。纯函数。
 *
 * 红线宁可错杀:命中 ⇒ 主人亲手批(decide 里变成 ask),错杀的代价只是多问一次。
 * 低风险宁可漏:shell 里只要出现复合 / 重定向 / 子命令替换就不算 —— 红线藏在 `ls && git push` 的后半截。
 *
 * 命令按「段 → 词」看,不按整串正则(终审 10-19:`git -C x push`、`/usr/bin/sudo`、`"git" push`、`\git push`
 * 都绕过了整串正则):先按 shell 操作符切段,每个词去掉引号与反斜杠、取 basename;一段里出现了 git,后面任何位置
 * 出现 push 就算推送 —— 不去理解 git 的全局选项,宁可多拦。
 */
import { homedir } from 'node:os'
import { canonPath, canonText, pathsUnder, type Platform } from './paths'
import { isDestructiveBash } from '../../domain/user-tier'
import type { PermissionAsk } from '../../domain/permission-rules/types'

export type ToolClass = 'read' | 'write' | 'shell' | 'other'

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'read', 'search'])
/** 不带路径也只在当前目录里找的读工具(Claude 的 Grep / Glob / LS)。ACP 的 read / search 不带 locations ⇒ 不知道读哪。 */
const CWD_SCOPED_READS = new Set(['Glob', 'Grep', 'LS'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'fileChange', 'edit', 'delete', 'move'])
const SHELL_TOOLS = new Set(['Bash', 'commandExecution', 'execute', 'shell'])

export function toolClass(tool: string): ToolClass {
  if (READ_TOOLS.has(tool)) return 'read'
  if (WRITE_TOOLS.has(tool)) return 'write'
  if (SHELL_TOOLS.has(tool)) return 'shell'
  return 'other'
}

export { pathsUnder } from './paths'

/**
 * 按 shell 操作符切段;每个词去引号 / 反斜杠、取 basename。带 `=` 的词(`of=/dev/disk2`、`FOO=/x`)不取 basename:
 * 它们是参数 / 赋值不是程序名,取了 basename 之后 dd 的 `of=` 就认不出了(2026-10 变异基线发现 `/bin/dd … of=/dev/…` 漏过红线)。
 */
export function commandSegments(cmd: string): string[][] {
  return rawSegments(cmd).map(seg => seg.map(w => (w.includes('/') && !w.startsWith('-') && !w.includes('://') && !w.includes('=') ? w.slice(w.lastIndexOf('/') + 1) || w : w)))
}
/** 同 commandSegments,但词不取 basename(下标一一对应):判网络目标要看整个词 —— `evil.com/x` 取了 basename 只剩 `x`。 */
function rawSegments(cmd: string): string[][] {
  return cmd.split(/[;&|\n\r()`]|\$\(/).map(seg => seg.split(/\s+/).map(w => w.replace(/['"\\]/g, '')).filter(Boolean)).filter(s => s.length)
}

const after = (seg: string[], head: string, ...tails: string[][]) => {
  const i = seg.indexOf(head)
  return i >= 0 && tails.some(t => t.every(w => seg.indexOf(w, i + 1) > i))
}

function publishes(seg: string[]): boolean {
  if (after(seg, 'git', ['push'], ['clean'], ['reset', '--hard'], ['branch', '-D'], ['filter-branch'], ['update-ref', '-d'])) return true
  for (const pm of ['npm', 'pnpm', 'yarn', 'bun', 'cargo']) if (after(seg, pm, ['publish'])) return true
  if (after(seg, 'gh', ['release'], ['pr', 'merge'], ['repo', 'delete'])) return true
  return after(seg, 'wechat-cc', ['self', 'deploy'], ['self', 'change'])
}
const SYSTEM_WORDS = new Set(['sudo', 'doas', 'su', 'launchctl', 'systemctl', 'crontab', 'chown', 'mkfs', 'diskutil', 'shred'])
const NET_WORDS = new Set(['nc', 'ncat', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'ftp', 'socat', 'aria2c', 'lynx', 'w3m'])
const LOCAL_TARGET = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::(?:\d+|\$\w+|\$\{\w+\}))?(?:[/?#]|$)/  // 端口可以是变量(localhost:$PORT)

/** 一个 curl / wget 参数要拿来判「是不是外面的主机」的那个样子:像本机路径的(`/…`、`./…`、`../…`、`~…`)照旧看 basename,
 * 别的看整个词 —— 不带协议头的 `evil.com/upload` 取了 basename 只剩 `upload`,认不出主机(2026-10 补词表时发现的漏洞)。 */
const netTarget = (raw: string, base: string) => (/^(?:\/|\.{1,2}\/|~)/.test(raw) ? base : raw)

/** 值是主机 / 网址的 `--x=` 选项(别的 `--x=…` 不是网址,如 `--resolve=localhost:80:127.0.0.1`)。 */
const HOST_VALUE_OPTS = ['--url=', '--proxy=', '--preproxy=', '--connect-to=']
/**
 * 往外连网。2026-10 两轮独立评审(#749、#750)补的按词漏判:
 *  - 直接往 `/dev/tcp/<host>/<port>`、`/dev/udp/…` 写(bash 的网络重定向;`>` 不切段,整个词取了 basename 只剩端口);
 *  - 值是主机的 `--url=` / `--proxy=` / `--preproxy=` / `--connect-to=`(带 `-` 的词以前一律跳过);
 *  - 目标是变量(`curl $URL`、`curl -s "$HOST/x"`):这一段里**没有一个写明的目标**、却有 `$…` ⇒ 看不出往哪连 ⇒ 当外面。
 *    有写明的本机目标时 `$…` 当数据(`-d "$BODY"`、`-H "X-Token:$T"`),本机端口是变量(`localhost:$PORT`)也算本机。
 *  - `$(…)` / 反引号的输出当目标:切段时被切走了,在 floorReason 里按原命令看(`curlSubstitution`)。
 * 不带点、不带冒号的裸主机名(`intranet/up`)仍认不出:跟本机相对路径(`-o out`)分不开,硬判会拦一大片正常命令。
 */
function outbound(seg: string[], raw: string[]): boolean {
  if (seg.some(w => NET_WORDS.has(w))) return true
  if (raw.some(w => /\/dev\/(?:tcp|udp)\//.test(w))) return true
  if (after(seg, 'openssl', ['s_client'], ['s_time'])) return true
  const i = seg.findIndex(w => w === 'curl' || w === 'wget')
  if (i < 0) return false
  const args = raw.slice(i + 1)
  for (const r of args) {
    const opt = HOST_VALUE_OPTS.find(o => r.startsWith(o))
    if (opt && !LOCAL_TARGET.test(r.slice(opt.length))) return true
  }
  if (seg.slice(i + 1).some((b, k) => { const t = netTarget(args[k]!, b); return !t.startsWith('-') && !t.includes('$') && /[.:]/.test(t) && !LOCAL_TARGET.test(t) })) return true
  const explicitTarget = args.some(r => !r.startsWith('-') && !r.includes('$') && (LOCAL_TARGET.test(r) || r.includes('://'))) || args.some(r => LOCAL_TARGET.test(r))
  return !explicitTarget && args.some(r => r.includes('$'))
}
/** `curl $(cat url)` / `` wget `cat u` ``:目标是命令替换的输出,切段时被切走了 ⇒ 按原命令看。 */
const curlSubstitution = (cmd: string) => /(?:^|[\s;&|(])(?:\S*\/)?(?:curl|wget)\b[^;&|\n]*(?:\$\(|`)/.test(cmd)

const SHELL_RC = /\.(?:zshrc|zprofile|zshenv|bashrc|bash_profile|profile)\b/
const SECRETS = [
  /(?:^|[\s'"=/~])\.(?:ssh|aws|gnupg|kube|docker|netrc|npmrc|pypirc|git-credentials|envrc)(?:\/|\b|$)/,
  /\.private_keys\b/,
  /\.config\/(?:gh|gcloud|op)\b/,
  /(?:^|[\s'"=/])\.env(?:$|[\s'"./-]|\b)/,
  /\.(?:p8|pem|p12|key|keystore|jks)\b/,
  /\bid_(?:rsa|dsa|ecdsa|ed25519)\b/,
  /\bcredentials(?:\.json)?\b/,
  /(?:^|[\s/])security\s+(?:find|dump|export)-/,
]
const CC_CONFIG = /(?:permission-rules|agent-config|access)\.json\b|\.claude\/channels\/wechat\b/
const GIT_INTERNALS = /(?:^|\/)\.git\//

/** 命中红线 ⇒ 一句中文理由;否则 null。stateDir = CC 自己的状态目录(整个算密钥 + 配置)。 */
export function floorReason(ask: PermissionAsk, home: string = homedir(), extra: { stateDir?: string; platform?: Platform } = {}): string | null {
  const platform = extra.platform ?? process.platform
  const cmd = ask.command ?? ''
  const paths = ask.paths ?? []
  const homeC = canonText(home, platform)
  // 子串比对一律在归一后的文本上做(win32:分隔符统一 + 小写),否则 C:\Users 与 c:/users 对不上。
  const text = canonText([cmd, ...paths.map(p => canonPath(p, platform))].join('\n'), platform).replaceAll(homeC, '~')
  const segs = cmd ? commandSegments(cmd) : []
  const projC = ask.project ? canonPath(ask.project, platform) : null
  const project = projC && projC !== canonPath(home, platform) && !/^(?:[a-z]:)?\/?$/.test(projC) ? ask.project : null
  if (toolClass(ask.tool) === 'write' && paths.length) {
    if (!project || !pathsUnder(paths, project, platform)) return '写到了项目目录之外'
    if (paths.some(p => GIT_INTERNALS.test(p))) return '改 .git 里面的东西'
  }
  if (cmd && (isDestructiveBash(cmd) || segs.some(s => s[0] === 'rm' || s.includes('rm') || (s.includes('dd') && s.some(w => /^(?:if|of)=/.test(w)))))) return '破坏性命令'
  if (segs.some(publishes)) return '推送 / 发布 / 部署'
  if (segs.some(s => s.some(w => SYSTEM_WORDS.has(w))) || SHELL_RC.test(text)) return '改系统或 shell 配置'
  if (extra.stateDir) {
    const sd = canonText(canonPath(extra.stateDir, platform), platform)
    if (text.includes(sd) || text.includes(sd.replaceAll(homeC, '~'))) return '碰到 CC 自己的状态目录'
  }
  if (SECRETS.some(r => r.test(text))) return '碰到密钥'
  if (CC_CONFIG.test(text)) return '改 CC 自己的配置'
  if (GIT_INTERNALS.test(cmd)) return '碰 .git 里面的东西'
  if (cmd) { const raws = rawSegments(cmd); if (curlSubstitution(cmd) || segs.some((s, k) => outbound(s, raws[k]!))) return '往外连网' }
  return null
}

const READ_ONLY_HEADS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'grep', 'rg', 'find'])
const GIT_READ_VERBS = new Set(['status', 'diff', 'log', 'show'])
const COMPOUND = /[;&|><\x60\n\r]|\$\(/
/** 会执行别的程序或写文件的选项(rg --pre、git --output / --ext-diff / --textconv、find -exec …)。 */
const RISKY_FLAGS = /(?:^|\s)(?:--pre(?:-glob)?\b|--output\b|--ext-diff\b|--textconv\b|--no-index\b|-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)\b)/

export function isLowRisk(ask: PermissionAsk): boolean {
  switch (toolClass(ask.tool)) {
    case 'read':
      if (!ask.paths?.length) return CWD_SCOPED_READS.has(ask.tool)
      return !!ask.project && pathsUnder(ask.paths, ask.project)
    case 'shell': {
      const c = ask.command?.trim()
      if (!c || COMPOUND.test(c) || RISKY_FLAGS.test(c)) return false
      const words = c.split(/\s+/)
      // 参数里出现绝对路径、~、..、盘符 ⇒ 读到项目外去了,不算低风险(2a 10-20:`cat ~/Library/Messages/chat.db`)。
      if (words.slice(1).some(w => /^['"]?(?:\/|~|[A-Za-z]:[\\/]|\\)/.test(w) || /(?:^|[\\/'"])\.\.(?:[\\/]|$)/.test(w))) return false
      if (words[0] === 'git') return GIT_READ_VERBS.has(words[1] ?? '')
      return READ_ONLY_HEADS.has(words[0]!)
    }
    case 'write':
      return ask.surface === 'workbench' && ask.isolatedWorktree && !!ask.project && !!ask.paths?.length && pathsUnder(ask.paths, ask.project)
    default: return false
  }
}
