// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
// ── hook — 终端 claude / codex / cursor 会话的事件推到微信(spec 2026-09-09-cli-hook-push)──
// 三家的 hooks 各拉起一个 `wechat-cc hook <source>` 子进程,stdin 是 hook JSON。
// Cursor 的 hook 一律同步等 stdout:权限类回 {permission},beforeSubmitPrompt 回 {continue:true}。
// 永远 exit 0、永远不阻塞 CLI:daemon 没跑 / 网络不通 / 400 一律静默
// (WECHAT_CC_HOOK_DEBUG=1 时把结果打到 stderr)。
type Src = 'claude' | 'codex' | 'cursor'
const ALL_SOURCES: readonly Src[] = ['claude', 'codex', 'cursor']

function hookRelayCmd(source: Src) {
  return defineCommand({
    meta: { name: source, description: `${source} 的 hook 出口(stdin 收 hook JSON,转给本机 daemon)` },
    async run() {
      const { runHookEntry } = await import('../hook-entry')
      await runHookEntry(source)
    },
  })
}

/**
 * 装:没点名 ⇒ claude + codex(老行为不变),cursor 只在点名 `--cursor` 时才写 —— ~/.cursor/hooks.json
 * 也管着主人的 IDE,不在他没开口时顺手写进去。撤:没点名 ⇒ 三家都撤(只删自家条目)。
 */
function hookTargets(args: { claude?: boolean; codex?: boolean; cursor?: boolean }, o: { cursorByDefault?: boolean } = {}): Src[] {
  const none = !args.claude && !args.codex && !args.cursor
  return ALL_SOURCES.filter(s => s === 'cursor' ? !!args.cursor || (none && !!o.cursorByDefault) : none || !!args[s])
}

async function hookFileFor(source: Src): Promise<string> {
  const { hookFileFor: fileFor } = await import('../terminal-hooks.ts')
  const { homedir } = await import('node:os')
  return fileFor(source, homedir(), process.env)
}

const hookInstallCmd = defineCommand({
  meta: { name: 'install', description: '把 wechat-cc 的 hooks 写进 ~/.claude/settings.json 与 $CODEX_HOME/hooks.json(幂等;缺省装这两家);--cursor 写 ~/.cursor/hooks.json' },
  args: {
    claude: { type: 'boolean', description: '只装 Claude Code' },
    codex: { type: 'boolean', description: '只装 Codex CLI' },
    cursor: { type: 'boolean', description: '装 Cursor(IDE 里的 agent 与 cursor-agent 共用 ~/.cursor/hooks.json;只在点名时装)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { installHooks } = await import('../hook.ts')
    // 命令行与 daemon 的 POST /v1/cli/hooks/install(桌面「接上」)同一个出处:terminal-hooks.ts selfHookCommand。
    const { selfHookCommand, defaultTerminalHooksDeps, readTerminalHooksForCli } = await import('../terminal-hooks.ts')
    const { codexTrustMessage, recordCodexHookDefinitionChange } = await import('../codex-hook-trust')
    const out: Record<string, unknown> = {}
    for (const source of hookTargets(args)) {
      const file = await hookFileFor(source)
      const command = selfHookCommand(source)
      try {
        const result = installHooks(file, source, command)
        const { changed } = result
        const deps = defaultTerminalHooksDeps()
        if (result.reconfirmationRequired && deps.evidenceFile) recordCodexHookDefinitionChange(deps.evidenceFile)
        const trust = source === 'codex' ? (await readTerminalHooksForCli(deps)).find(s => s.source === 'codex')?.trust : undefined
        out[source] = { ok: true, file, ...result, command, ...(trust ? { trust } : {}) }
        if (!args.json) console.log(`${changed ? '✅' : '✔'} ${source}: ${changed ? '已写入' : '已是最新'} ${file}`)
        if (!args.json && source === 'codex') {
          if (result.reconfirmationRequired) console.log('Codex 需要重新确认一次。')
          if (trust) console.log(codexTrustMessage(trust))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        out[source] = { ok: false, file, error: msg }
        if (!args.json) console.error(`❌ ${source}: ${msg}`)
      }
    }
    if (args.json) { console.log(JSON.stringify(out)); return }
    console.log('之后终端里的 claude / codex(装了 --cursor 的话还有 Cursor)跑完一个长回合,主人微信会收到一条(压 45s;期间你再敲一句就不发;一次提问最多推一条)。')
    console.log('停下来等批准时:你最近 3 分钟没在终端敲过字 ⇒ 微信里收到卡片,回「y 码」/「n 码」就替终端拍板(120s 内);否则终端自己问。')
    console.log('daemon 自己拉起的会话不会推(回环守卫)。查看:wechat-cc hook status;撤掉:wechat-cc hook uninstall。')
    console.log('连接完成后，新会话会收到 CC 记下的项目近况；设置中可关闭。')
  },
})

const hookUninstallCmd = defineCommand({
  meta: { name: 'uninstall', description: '只删 wechat-cc 自己的 hook 条目,别人的原样保留' },
  args: {
    claude: { type: 'boolean', description: '只删 Claude Code 的' },
    codex: { type: 'boolean', description: '只删 Codex CLI 的' },
    cursor: { type: 'boolean', description: '删 Cursor 的(~/.cursor/hooks.json)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { uninstallHooks } = await import('../hook.ts')
    const out: Record<string, unknown> = {}
    for (const source of hookTargets(args, { cursorByDefault: true })) {
      const file = await hookFileFor(source)
      try {
        const r = uninstallHooks(file, source)
        out[source] = { ok: true, file, ...r }
        if (!args.json) console.log(`${r.changed ? '✅' : '✔'} ${source}: ${r.changed ? `删了 ${r.removed} 条` : '本来就没装'}(${file})`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        out[source] = { ok: false, file, error: msg }
        if (!args.json) console.error(`❌ ${source}: ${msg}`)
      }
    }
    if (args.json) console.log(JSON.stringify(out))
  },
})

const hookStatusCmd = defineCommand({
  meta: { name: 'status', description: '三家(Claude Code / Codex / Cursor)的 hook 装没装、命令行是什么' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { defaultTerminalHooksDeps, readTerminalHooksForCli } = await import('../terminal-hooks.ts')
    const { codexTrustMessage } = await import('../codex-hook-trust')
    const out: Record<string, unknown> = {}
    for (const st of await readTerminalHooksForCli(defaultTerminalHooksDeps())) {
      const { source, file } = st
      out[source] = st
      if (!args.json) console.log(`${st.installed ? '✅' : '—'} ${source}: ${st.installed ? st.command : '未安装'}(${file})`)
      if (!args.json && st.trust) console.log(codexTrustMessage(st.trust))
    }
    if (args.json) console.log(JSON.stringify(out))
  },
})

export const hookCmd = defineCommand({
  meta: { name: 'hook', description: '终端 claude / codex / cursor 会话的事件推到微信(hooks 出口):install / uninstall / status;claude / codex / cursor 由 hooks 自己调' },
  subCommands: { claude: hookRelayCmd('claude'), codex: hookRelayCmd('codex'), cursor: hookRelayCmd('cursor'), install: hookInstallCmd, uninstall: hookUninstallCmd, status: hookStatusCmd },
})
