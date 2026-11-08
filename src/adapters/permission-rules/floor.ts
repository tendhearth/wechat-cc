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
  return rawSegments(cmd).map(seg => seg.map(baseName))
}
const baseName = (w: string) => (w.includes('/') && !w.startsWith('-') && !w.includes('://') && !w.includes('=') ? w.slice(w.lastIndexOf('/') + 1) || w : w)
/** 同 commandSegments,但词不取 basename(下标一一对应):判网络目标要看整个词 —— `evil.com/x` 取了 basename 只剩 `x`。 */
function rawSegments(cmd: string): string[][] {
  return toWords(cmd.split(/[;&|\n\r()`]|\$\(/))
}
/**
 * 词按空白切,再去引号 / 反斜杠。去完是空的(`""`、`''`)也留一个空词占位:否则 `curl -d "" intranet/up` 里 `-d` 吃掉的是网址(#761 评审)。
 */
const toWords = (segs: string[]) => segs.map(seg => seg.split(/\s+/).filter(Boolean).map(w => w.replace(/['"\\]/g, ''))).filter(s => s.length)
/**
 * 判网络用的第二种切段,跟 rawSegments **叠加**(两种都判,任一命中就算):rawSegments 遇到 `;&|`、换行一律切 —— 这是底线,
 * 新加的切法再怎么判错,也藏不掉 rawSegments 看得见的段(#761 第二轮评审:`grep \>& curl intranet` 曾因为只按新切法判而漏)。
 * 这一种按 shell 的样子切,补 rawSegments 切错的地方,一遍扫完、认引号和反斜杠:
 *  - 引号里的 `;` `|` 不切(`curl -d "x;" intranet/up`);
 *  - 重定向里的 `&` 不切(`curl -s 2>&1 evil.com/x`、`&>/dev/null`):前一个字符是引号外、没被转义的 `<` `>`,或后面紧跟 `>`;
 *  - 续行接回一行:引号外 / 双引号里、没被转义的 `\` 后面紧跟换行(含 CRLF)。`\\` + 换行是转义的反斜杠 + 真换行,照切。
 * 词仍按空白切:只会多出位置参数(多问),不会把网址并进选项值。
 */
function shellSegments(cmd: string): string[][] {
  const segs: string[] = []
  let cur = '', q: string | null = null, angle = false
  for (let k = 0; k < cmd.length; k++) {
    const c = cmd[k]!
    if (q === "'") { if (c === q) q = null; cur += c; angle = false; continue }
    if (c === '\\') {
      const n = cmd[k + 1] ?? ''
      if (n === '\n') { cur += ' '; k++ } else if (n === '\r' && cmd[k + 2] === '\n') { cur += ' '; k += 2 } else { cur += c + n; k++ }
      angle = false
      continue
    }
    if (q) { if (c === q) q = null; cur += c; angle = false; continue }
    if (c === "'" || c === '"') { q = c; cur += c; angle = false; continue }
    const redirectAmp = c === '&' && (angle || cmd[k + 1] === '>')
    if ((/[;&|\n\r()`]/.test(c) && !redirectAmp) || (c === '$' && cmd[k + 1] === '(')) { segs.push(cur); cur = ''; angle = false; continue }
    cur += c
    angle = c === '<' || c === '>'
  }
  segs.push(cur)
  return toWords(segs)
}
/** 命令里有没有在引号里 / 被转义的 `<` `>`(那是给程序的参数,不是重定向)。 */
function hasLiteralAngle(cmd: string): boolean {
  let q: string | null = null
  for (let k = 0; k < cmd.length; k++) {
    const c = cmd[k]!
    if (c === '\\') { if (/[<>]/.test(cmd[k + 1] ?? '')) return true; if (q !== "'") k++; continue }
    if (q) { if (c === q) q = null; else if (c === '<' || c === '>') return true; continue }
    if (c === "'" || c === '"') q = c
  }
  return false
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
 *  - 不带点、不带冒号的裸主机名(`curl intranet/up`):按工具自己的参数语法认(`netOperands`),位置参数就是网址。
 */
function outbound(seg: string[], raw: string[], redirects = false): boolean {
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
  if (!explicitTarget && args.some(r => r.includes('$'))) return true
  if (!invoked(seg, i)) return false
  // xargs / parallel 把标准输入接到 curl 后面当参数 ⇒ 网址看不见
  if (seg.slice(0, i).some(w => w === 'xargs' || w === 'parallel')) return true
  return netOperands(seg[i] as 'curl' | 'wget', args, redirects)
}

/**
 * 按 curl / wget 自己的参数语法分「选项值」和「位置参数」(#750 留下的裸主机名):位置参数都是网址(curl 把 `intranet/up`
 * 当 http://intranet/up),只有 LOCAL_TARGET 放行;选项值多数是文件 / 数据,少数本身就是主机(代理、socks、doh)。
 * 只在上面那几条按词判之外**加**判,不替换 —— 判错的方向只会是多问。
 * 拿不准的一律往「多问」偏:不认识的选项当不带值(下一个词照位置参数判);只把 --help 里确实带值的列进 `value`。
 * 合写的短选项(`-sSo out`、`-oout`)按 getopt:第一个带值的字母吃掉本词剩下的,没剩就吃下一个词。
 */
type NetGrammar = {
  short: string                      // 带值的短选项字母(curl 8.7 / wget 1.25 的 --help 里带 <…> / =… 的)
  shortLong: Record<string, string>  // 其中要特殊对待的短选项 → 长名
  value: Set<string>                 // 带值的长选项
  target: Set<string>                // 值本身是主机 / 网址
  fromFile: Set<string>              // 网址 / 代理写在文件里,看不见 ⇒ 当外面
  flags?: Set<string>                // 不带值的长选项;给了就按 GNU getopt_long 认唯一前缀
}
const longs = (s: string) => new Set(s.trim().split(/\s+/).map(o => `--${o}`))
const CURL: NetGrammar = {
  short: 'AbcCdDeEFhHKmoPQrtTuUwxXyYz',
  shortLong: { x: '--proxy', K: '--config' },
  value: longs(`abstract-unix-socket alt-svc aws-sigv4 cacert capath cert cert-type ciphers config connect-timeout connect-to continue-at cookie cookie-jar
    create-file-mode crlfile curves data data-ascii data-binary data-raw data-urlencode delegation dns-interface dns-ipv4-addr dns-ipv6-addr dns-servers doh-url
    dump-header egd-file engine etag-compare etag-save expect100-timeout form form-string ftp-account ftp-alternative-to-user ftp-method ftp-port ftp-ssl-ccc-mode
    happy-eyeballs-timeout-ms haproxy-clientip header help hostpubmd5 hostpubsha256 hsts interface ipfs-gateway json keepalive-time key key-type krb libcurl
    limit-rate local-port login-options mail-auth mail-from mail-rcpt max-filesize max-redirs max-time netrc-file noproxy oauth2-bearer output output-dir
    parallel-max pass pinnedpubkey preproxy proto proto-default proto-redir proxy proxy-cacert proxy-capath proxy-cert proxy-cert-type proxy-ciphers proxy-crlfile
    proxy-header proxy-key proxy-key-type proxy-pass proxy-pinnedpubkey proxy-service-name proxy-tls13-ciphers proxy-tlsauthtype proxy-tlspassword proxy-tlsuser
    proxy-user proxy1.0 pubkey quote random-file range rate referer request request-target resolve retry retry-delay retry-max-time sasl-authzid service-name
    socks4 socks4a socks5 socks5-gssapi-service socks5-hostname speed-limit speed-time stderr telnet-option tftp-blksize time-cond tls-max tls13-ciphers
    tlsauthtype tlspassword tlsuser trace trace-ascii trace-config unix-socket upload-file url url-query user user-agent variable write-out`),
  target: longs('url proxy preproxy proxy1.0 socks4 socks4a socks5 socks5-hostname doh-url ipfs-gateway dns-servers connect-to'),
  fromFile: longs('config'),
}
const WGET: NetGrammar = {
  short: 'eoaiBtOTwQPUlARDIX',
  shortLong: { e: '--execute', i: '--input-file', B: '--base' },
  value: longs(`execute output-file append-output report-speed input-file base config rejected-log tries retry-on-http-error output-document start-pos progress
    timeout dns-timeout connect-timeout read-timeout wait waitretry quota bind-address bind-dns-address dns-servers limit-rate restrict-file-names prefer-family user
    password use-askpass local-encoding remote-encoding directory-prefix cut-dirs http-user http-password default-page header compression proxy-user proxy-password
    referer user-agent load-cookies save-cookies post-data post-file method body-data body-file secure-protocol certificate certificate-type private-key
    private-key-type ca-certificate ca-directory crl-file pinnedpubkey random-file egd-file hsts-file ciphers ftp-user ftp-password warc-file warc-header
    warc-max-size warc-dedup warc-tempdir level backups accept reject accept-regex reject-regex regex-type domains exclude-domains follow-tags ignore-tags
    include-directories exclude-directories max-redirect`),
  target: longs('base dns-servers'),
  fromFile: longs('input-file config'),
  // wget 1.25 `--help` 里不带 `=…` 的长选项(布尔开关;`--no-xxx` 形式 getopt 也认)
  flags: longs(`adjust-extension ask-password auth-no-challenge background backup-converted content-disposition content-on-error continue convert-file-only
    convert-links debug delete-after follow-ftp force-directories force-html ftps-clear-data-connection ftps-fallback-to-ftp ftps-implicit ftps-resume-ssl help hsts
    https-only ignore-case ignore-length inet4-only inet6-only keep-session-cookies mirror no-cache no-check-certificate no-clobber no-config no-cookies
    no-directories no-dns-cache no-glob no-host-directories no-hsts no-http-keep-alive no-if-modified-since no-iri no-netrc no-parent no-passive-ftp no-proxy
    no-remove-listing no-use-server-timestamps no-verbose no-warc-compression no-warc-digests no-warc-keep-log page-requisites preserve-permissions
    protocol-directories quiet random-wait recursive relative retr-symlinks retry-connrefused retry-on-host-error save-headers server-response show-progress
    span-hosts spider strict-comments timestamping trust-server-names unlink verbose version warc-cdx xattr iri`),
}
/**
 * 只读、不执行参数的命令把 curl 当数据(`grep -rn curl src`、`brew install curl wget`)。不在内的:echo / printf(输出常被管给 sh)、
 * git(`-c core.pager=… / alias.x=!…` 会执行)、man / less / more(pager)、ag / ack(`--pager`,ack 还读项目里的 .ackrc)。
 * rg 带 `--pre` / `--pager` 会拿别的程序跑。装包命令只在只读 / 装卸动词下算数据:`brew bundle exec -- curl …` 会执行(#761 评审)。
 */
const DATA_HEADS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'which', 'whereis', 'type', 'whatis', 'apropos', 'tldr', 'cat', 'head', 'tail', 'wc', 'ls'])
const PKG_HEADS = new Set(['brew', 'apt', 'apt-get', 'dnf', 'yum', 'pip', 'pip3'])
const PKG_VERBS = new Set(['install', 'uninstall', 'remove', 'reinstall', 'upgrade', 'info', 'search', 'list', 'show', 'desc', 'home', 'deps', 'uses', 'outdated'])
function invoked(seg: string[], i: number): boolean {
  if (i === 0 || seg.some(w => w.startsWith('--pre') || w.startsWith('--pager'))) return true
  if (DATA_HEADS.has(seg[0]!)) return false
  return !(PKG_HEADS.has(seg[0]!) && PKG_VERBS.has(seg.slice(1).find(w => !w.startsWith('-')) ?? ''))
}
/** shell 重定向(`> out`、`2>/dev/null`、`>>log`、`< body`、`2>&1`、`&>log`):目标是文件。 */
const REDIRECT = /^(?:\d*|&)(?:>>?|<<?<?|>\||[<>]&)(.*)$/
const LOOPBACK_ADDR = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/

/**
 * 这次 curl / wget 有没有往本机以外的目标去(或目标看不见)。redirects = 命令里没有带引号 / 转义的 `<` `>`,
 * 词里的 `>` 就是 shell 重定向(词已去掉引号:`curl ">" intranet` 的 `>` 是给 curl 的参数,不能把 intranet 当重定向目标跳过)。
 */
function netOperands(tool: 'curl' | 'wget', args: string[], redirects: boolean): boolean {
  const g = tool === 'curl' ? CURL : WGET
  const targets: string[] = []
  let unseen = false, endOpts = false
  const take = (opt: string, val: string | undefined) => {
    if (val === undefined) return
    if (g.fromFile.has(opt)) unseen = true
    else if (g.target.has(opt)) targets.push(val)
    // `--resolve [+]host:port:addr[,addr]`:地址不是本机回环 ⇒ 本机名被解析到外面去
    else if (opt === '--resolve' && !val.replace(/^[+-]?[^:]*:[^:]*:?/, '').split(',').every(a => !a || LOOPBACK_ADDR.test(a))) unseen = true
    // wget `-e https_proxy=host`:wgetrc 命令里的代理
    else if (opt === '--execute') { const m = /proxy\s*=\s*(.*)$/i.exec(val); if (m) targets.push(m[1] || '?') }
  }
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    const redir = redirects ? REDIRECT.exec(a) : null
    if (redir) { if (!redir[1]) k++; continue }
    // 空词(`""`)当位置参数没有目标:curl 拿到空网址只会报错
    if (endOpts || a === '-' || !a.startsWith('-')) { if (a) targets.push(a); continue }
    if (a === '--') { endOpts = true; continue }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = longName(g, eq >= 0 ? a.slice(0, eq) : a)
      // 不认识的 `--x=值`:值当可能的目标(curl 老版本 / wget 认缩写,`--prepr=intranet`;#761 评审)
      if (eq >= 0) { if (name) take(name, a.slice(eq + 1)); else targets.push(a.slice(eq + 1)) }
      else if (name) take(name, args[++k])
      continue
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!
      if (!g.short.includes(c)) continue
      take(g.shortLong[c] ?? `-${c}`, j + 1 < a.length ? a.slice(j + 1) : args[++k])
      break
    }
  }
  return unseen || targets.some(t => !LOCAL_TARGET.test(t))
}
/**
 * 带值的长选项的全名;不带值 / 不认识 ⇒ null。wget(GNU getopt_long)认唯一前缀(`--input-f=urls`),跟 getopt 一样配:
 * 先看全名完全相同的(带值、不带值的都算 —— `--hsts` 是布尔,不是 `--hsts-file` 的缩写;#761 第二轮评审),
 * 再在全部长选项里找前缀,只配上一个且它带值才用。配上多个 = wget 报错;按不认识处理(下一个词照位置参数判,多问)。
 * curl 8.7 不认缩写也不认 `=`,不做前缀。
 */
function longName(g: NetGrammar, name: string): string | null {
  if (g.value.has(name)) return name
  if (!g.flags || g.flags.has(name)) return null
  const hits = [...g.value, ...g.flags].filter(o => o.startsWith(name))
  return hits.length === 1 && g.value.has(hits[0]!) ? hits[0]! : null
}
/** `curl $(cat url)` / `` wget `cat u` ``:目标是命令替换的输出,切段时被切走了 ⇒ 按原命令看。 */
const curlSubstitution = (cmd: string) => /(?:^|[\s;&|(])(?:\S*\/)?(?:curl|wget)\b(?:[^;&|\n]|[<>]&|&>)*(?:\$\(|`)/.test(cmd)

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
  if (cmd) {
    const raws = rawSegments(cmd)
    const redirects = !hasLiteralAngle(cmd)
    if (curlSubstitution(cmd) || segs.some((s, k) => outbound(s, raws[k]!, redirects))) return '往外连网'
    // 同一套判法在按 shell 样子切的段上再跑一遍(叠加,不替换):`curl -d "x;" intranet/up`、`curl -s 2>&1 evil.com/x`
    if (shellSegments(cmd).some(r => outbound(r.map(baseName), r, redirects))) return '往外连网'
  }
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
