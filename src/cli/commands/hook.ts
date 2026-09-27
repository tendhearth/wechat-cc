// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { CLI_ENTRY } from '../repo-root'
import { isCompiledBundle } from '../../lib/runtime-info'
import { readStdin } from '../stdin'
// ── hook — 终端 claude / codex 会话的事件推到微信(spec 2026-09-09-cli-hook-push)──
// 两家的 hooks 各拉起一个 `wechat-cc hook <source>` 子进程,stdin 是 hook JSON。
// 永远 exit 0、永远不阻塞 CLI:daemon 没跑 / 网络不通 / 400 一律静默
// (WECHAT_CC_HOOK_DEBUG=1 时把结果打到 stderr)。
function hookRelayCmd(source: 'claude' | 'codex') {
  return defineCommand({
    meta: { name: source, description: `${source} 的 hook 出口(stdin 收 hook JSON,转给本机 daemon)` },
    async run() {
      const { shouldSkipHook, normalizeHookPayload, postCliEvent, parsePermissionRequest, relayPermission, permissionDecisionOutput, withMachineContext } = await import('../hook.ts')
      const debug = process.env['WECHAT_CC_HOOK_DEBUG'] === '1'
      try {
        // 回环守卫:daemon 自己拉起的 claude / codex 也会触发同一份 hooks。
        if (shouldSkipHook(process.env)) { if (debug) console.error('hook: skipped (daemon child)'); return }
        const raw = await readStdin()
        let parsed: unknown = null
        try { parsed = JSON.parse(raw) } catch { if (debug) console.error('hook: stdin is not JSON'); return }
        // PermissionRequest:去微信问主人;拿到 y/n 就往 stdout 写答复(两家同形状)。
        // 主人在场 / 没答 / daemon 没跑 → 什么都不写,终端自己弹提示;顺手按老规矩
        // 压一条「等你批准」提醒(刚发过卡片的话 daemon 那头会压掉)。
        const perm = parsePermissionRequest(source, parsed)
        if (perm) {
          const r = await relayPermission(STATE_DIR, await withMachineContext(perm))
          if (debug) console.error(`hook: permission ${JSON.stringify(r)}`)
          if (r.decision) { process.stdout.write(permissionDecisionOutput(r.decision) + '\n'); return }
          await postCliEvent(STATE_DIR, await withMachineContext({ source, kind: 'permission' as const, session_id: perm.session_id, cwd: perm.cwd, text: perm.summary ? `${perm.tool_name}: ${perm.summary}` : perm.tool_name }))
          return
        }
        const ev = normalizeHookPayload(source, parsed)
        if (!ev) { if (debug) console.error('hook: event ignored'); return }
        // prompt / session_end 不用探空闲(它们本身就说明有人在);stop / permission 要。
        const r = await postCliEvent(STATE_DIR, ev.kind === 'stop' || ev.kind === 'permission' ? await withMachineContext(ev) : ev)
        if (debug) console.error(`hook: ${JSON.stringify(r)}`)
      } catch (err) {
        if (debug) console.error(`hook: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })
}

function hookTargets(args: { claude?: boolean; codex?: boolean }): ('claude' | 'codex')[] {
  const both = !args.claude && !args.codex
  return [...(both || args.claude ? ['claude' as const] : []), ...(both || args.codex ? ['codex' as const] : [])]
}

async function hookFileFor(source: 'claude' | 'codex'): Promise<string> {
  const { claudeSettingsPath, codexHooksPath } = await import('../hook.ts')
  const { homedir } = await import('node:os')
  return source === 'claude' ? claudeSettingsPath(homedir()) : codexHooksPath(homedir(), process.env)
}

const hookInstallCmd = defineCommand({
  meta: { name: 'install', description: '把 wechat-cc 的 hooks 写进 ~/.claude/settings.json 与 $CODEX_HOME/hooks.json(幂等;缺省两家都装)' },
  args: {
    claude: { type: 'boolean', description: '只装 Claude Code' },
    codex: { type: 'boolean', description: '只装 Codex CLI' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { installHooks, hookCommandLine } = await import('../hook.ts')
    // 原来是 fileURLToPath(import.meta.url)(cli.ts 自己);搬进 src/cli/commands/ 后改从 repo-root 取。
    const cliEntry = CLI_ENTRY
    const out: Record<string, unknown> = {}
    for (const source of hookTargets(args)) {
      const file = await hookFileFor(source)
      const command = hookCommandLine({ execPath: process.execPath, compiled: isCompiledBundle(), cliEntry, source })
      try {
        const { changed } = installHooks(file, source, command)
        out[source] = { ok: true, file, changed, command }
        if (!args.json) console.log(`${changed ? '✅' : '✔'} ${source}: ${changed ? '已写入' : '已是最新'} ${file}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        out[source] = { ok: false, file, error: msg }
        if (!args.json) console.error(`❌ ${source}: ${msg}`)
      }
    }
    if (args.json) { console.log(JSON.stringify(out)); return }
    console.log('之后终端里的 claude / codex 跑完一个长回合,主人微信会收到一条(压 45s;期间你再敲一句就不发;一次提问最多推一条)。')
    console.log('停下来等批准时:你最近 3 分钟没在终端敲过字 ⇒ 微信里收到卡片,回「y 码」/「n 码」就替终端拍板(120s 内);否则终端自己问。')
    console.log('daemon 自己拉起的会话不会推(回环守卫)。查看:wechat-cc hook status;撤掉:wechat-cc hook uninstall。')
  },
})

const hookUninstallCmd = defineCommand({
  meta: { name: 'uninstall', description: '只删 wechat-cc 自己的 hook 条目,别人的原样保留' },
  args: {
    claude: { type: 'boolean', description: '只删 Claude Code 的' },
    codex: { type: 'boolean', description: '只删 Codex CLI 的' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { uninstallHooks } = await import('../hook.ts')
    const out: Record<string, unknown> = {}
    for (const source of hookTargets(args)) {
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
  meta: { name: 'status', description: '两家的 hook 装没装、命令行是什么' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { hookStatus } = await import('../hook.ts')
    const out: Record<string, unknown> = {}
    for (const source of ['claude', 'codex'] as const) {
      const file = await hookFileFor(source)
      const st = hookStatus(file, source)
      out[source] = { file, ...st }
      if (!args.json) console.log(`${st.installed ? '✅' : '—'} ${source}: ${st.installed ? st.command : '未安装'}(${file})`)
    }
    if (args.json) console.log(JSON.stringify(out))
  },
})

export const hookCmd = defineCommand({
  meta: { name: 'hook', description: '终端 claude / codex 会话的事件推到微信(hooks 出口):install / uninstall / status;claude / codex 由 hooks 自己调' },
  subCommands: { claude: hookRelayCmd('claude'), codex: hookRelayCmd('codex'), install: hookInstallCmd, uninstall: hookUninstallCmd, status: hookStatusCmd },
})
