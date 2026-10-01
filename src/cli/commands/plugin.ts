// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import selfPkg from '../../../package.json' with { type: 'json' }
import { STATE_DIR } from '../../lib/config'
// Plugin management (MCP tool providers). Discovery is not
// consent — user-dir plugins stay disabled until `plugin enable`.
const pluginListCmd = defineCommand({
  meta: { name: 'list', description: 'List discovered plugins and their enable/ready state' },
  args: { json: { type: 'boolean', description: 'JSON output' } },
  async run({ args }) {
    const { loadPlugins } = await import('../../daemon/plugins/registry')
    const { bundledPluginsDir } = await import('../../daemon/plugins/paths')
    const loaded = loadPlugins({ stateDir: STATE_DIR, bundledDir: bundledPluginsDir(STATE_DIR), hostVersion: selfPkg.version })
    if (args.json) {
      console.log(JSON.stringify(loaded.map(p => ({
        name: p.name, source: p.source, version: p.manifest.version ?? null,
        enabled: p.enabled, ready: p.ready,
        notReadyReason: p.notReadyReason ?? null, displayName: p.manifest.displayName ?? null,
      })), null, 2))
      return
    }
    if (loaded.length === 0) {
      console.log('no plugins found — drop one into ~/.claude/channels/wechat/plugins/<name>/ (see docs/plugins.md)')
      return
    }
    for (const p of loaded) {
      const state = !p.enabled ? 'disabled' : p.ready ? 'enabled + ready' : `enabled but NOT READY (${p.notReadyReason})`
      const ver = p.manifest.version ? ` v${p.manifest.version}` : ''
      console.log(`${p.enabled && p.ready ? '●' : '○'} ${p.name}${ver}  [${p.source}]  ${state}`)
    }
  },
})

const pluginEnableCmd = defineCommand({
  meta: { name: 'enable', description: 'Enable a plugin (agent gets its tools after a daemon restart)' },
  args: { name: { type: 'positional', required: true, description: 'Plugin name', valueHint: 'name' } },
  async run({ args }) {
    const { setPluginEnabled } = await import('../../daemon/plugins/registry')
    setPluginEnabled(STATE_DIR, args.name, true)
    console.log(`enabled "${args.name}" — restart the daemon to load it`)
  },
})

const pluginDisableCmd = defineCommand({
  meta: { name: 'disable', description: 'Disable a plugin' },
  args: { name: { type: 'positional', required: true, description: 'Plugin name', valueHint: 'name' } },
  async run({ args }) {
    const { setPluginEnabled } = await import('../../daemon/plugins/registry')
    setPluginEnabled(STATE_DIR, args.name, false)
    console.log(`disabled "${args.name}" — restart the daemon to unload it`)
  },
})

const pluginSearchCmd = defineCommand({
  meta: { name: 'search', description: 'Browse the plugin registry (the market)' },
  args: {
    query: { type: 'positional', required: false, description: 'Filter by name/description', valueHint: 'query' },
    json: { type: 'boolean', description: 'JSON output' },
  },
  async run({ args }) {
    const { fetchCatalog, updateAvailable } = await import('../../daemon/plugins/catalog')
    const { loadPlugins } = await import('../../daemon/plugins/registry')
    const { bundledPluginsDir } = await import('../../daemon/plugins/paths')
    const installed = new Map(loadPlugins({ stateDir: STATE_DIR, bundledDir: bundledPluginsDir(STATE_DIR) }).map(p => [p.name, p.manifest.version]))
    let catalog
    try { catalog = await fetchCatalog() } catch (err) {
      console.error(`registry unavailable: ${err instanceof Error ? err.message : String(err)}`)
      console.error('set WECHAT_CC_PLUGIN_REGISTRY to your registry URL (or a local path). See docs/registry.example.json')
      process.exit(1)
    }
    const q = (args.query ?? '').toLowerCase()
    const rows = catalog.plugins.filter(p =>
      !q || p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q))
    if (args.json) { console.log(JSON.stringify(rows, null, 2)); return }
    if (rows.length === 0) { console.log('no matching plugins'); return }
    for (const p of rows) {
      const has = installed.has(p.name)
      const tag = !has ? '' : updateAvailable(installed.get(p.name), p) ? `  ⬆ update ${installed.get(p.name)}→${p.version}` : '  ✓ installed'
      console.log(`  ${p.name} v${p.version}${tag}\n    ${p.description ?? p.displayName ?? ''}`)
    }
  },
})

const pluginInstallCmd = defineCommand({
  meta: { name: 'install', description: 'Install a plugin from the registry (git clone; stays disabled until you enable it)' },
  args: { name: { type: 'positional', required: true, description: 'Plugin name from `plugin search`', valueHint: 'name' } },
  async run({ args }) {
    const { fetchCatalog, installPlugin } = await import('../../daemon/plugins/catalog')
    const catalog = await fetchCatalog().catch(err => {
      console.error(`registry unavailable: ${err instanceof Error ? err.message : String(err)}`); process.exit(1)
    })
    const entry = catalog.plugins.find(p => p.name === args.name)
    if (!entry) { console.error(`"${args.name}" not in registry — try \`plugin search\``); process.exit(1) }
    console.log(`installing ${entry.name} v${entry.version} from ${entry.source.url}${entry.source.ref ? '#' + entry.source.ref : ''} …`)
    const r = installPlugin(entry, STATE_DIR)
    if (!r.ok) { console.error(`install failed: ${r.reason}`); process.exit(1) }
    console.log(`installed to ${r.dir} (disabled). Next:\n  wechat-cc plugin enable ${entry.name}\n  # then finish any plugin-specific setup and restart the daemon`)
  },
})

const pluginUpgradeCmd = defineCommand({
  meta: { name: 'upgrade', description: 'Upgrade an installed plugin to the registry version (preserves plugin data)' },
  args: {
    name: { type: 'positional', required: false, description: 'Plugin name (omit with --all)', valueHint: 'name' },
    all: { type: 'boolean', description: 'Upgrade every installed plugin that has an update' },
  },
  async run({ args }) {
    const { fetchCatalog, upgradePlugin, updateAvailable } = await import('../../daemon/plugins/catalog')
    const { loadPlugins } = await import('../../daemon/plugins/registry')
    const { bundledPluginsDir } = await import('../../daemon/plugins/paths')
    const catalog = await fetchCatalog().catch(err => {
      console.error(`registry unavailable: ${err instanceof Error ? err.message : String(err)}`); process.exit(1)
    })
    const byName = new Map(catalog.plugins.map(p => [p.name, p]))
    let targets: import('../../daemon/plugins/catalog').CatalogEntry[] = []
    if (args.all) {
      const installed = loadPlugins({ stateDir: STATE_DIR, bundledDir: bundledPluginsDir(STATE_DIR) })
      for (const p of installed) {
        const e = byName.get(p.name)
        if (e && updateAvailable(p.manifest.version, e)) targets.push(e)
      }
    } else {
      if (!args.name) { console.error('pass a plugin name or --all'); process.exit(1) }
      const e = byName.get(args.name)
      if (!e) { console.error(`"${args.name}" not in registry`); process.exit(1) }
      targets = [e]
    }
    if (targets.length === 0) { console.log('everything is up to date'); return }
    let failed = false
    for (const e of targets) {
      const r = upgradePlugin(e, STATE_DIR)
      if (!r.ok) { console.error(`✗ ${e.name}: ${r.reason}`); failed = true }
      else if (!r.upgraded) console.log(`= ${e.name} already at ${r.to}`)
      else console.log(`⬆ ${e.name} ${r.from ?? '?'} → ${r.to}`)
    }
    console.log('restart the daemon to load upgraded plugins')
    if (failed) process.exit(1)
  },
})

const pluginSetupCmd = defineCommand({
  meta: { name: 'setup', description: "Run a plugin's one-time setup, streaming progress (desktop 「连接微信」 calls this)" },
  args: { name: { type: 'positional', required: true, description: 'Plugin name', valueHint: 'name' } },
  async run({ args }) {
    const { loadPlugins } = await import('../../daemon/plugins/registry')
    const { bundledPluginsDir, pluginDataDir } = await import('../../daemon/plugins/paths')
    const { spawn } = await import('node:child_process')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const p = loadPlugins({ stateDir: STATE_DIR, bundledDir: bundledPluginsDir(STATE_DIR) }).find(x => x.name === args.name)
    if (!p) { console.error(`plugin "${args.name}" not found`); process.exit(1) }
    if (!p.manifest.setup) { console.error(`plugin "${args.name}" declares no runnable setup`); process.exit(1) }
    // ${dataDir} = the plugin's writable data dir; create it so setup can write
    // there (a bundled plugin's own dir is read-only/wiped-on-upgrade).
    const dataDir = pluginDataDir(STATE_DIR, p.name)
    mkdirSync(dataDir, { recursive: true })
    const sub = (s: string) => s.split('${pluginDir}').join(p.dir).split('${dataDir}').join(dataDir)
    const setup = p.manifest.setup
    const env = { ...process.env, ...Object.fromEntries(Object.entries(setup.env ?? {}).map(([k, v]) => [k, sub(v)])) }
    // Progress file the desktop wizard polls (same pattern as install-progress.json).
    const progressFile = join(STATE_DIR, 'plugin-setup-progress.json')
    const writeProgress = (o: Record<string, unknown>) => {
      try { writeFileSync(progressFile, JSON.stringify({ plugin: args.name, ...o })) } catch { /* best effort */ }
    }
    writeProgress({ running: true, stage: 0, total: 0, label: 'starting' })
    const child = spawn(sub(setup.command), (setup.args ?? []).map(sub), { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        process.stdout.write(line + '\n')                                  // live echo (CLI)
        const m = line.replace(/\x1b\[[0-9;]*m/g, '').match(/\[(\d+)\/(\d+)\]\s*(.+)/) // parse "[N/M] label"
        if (m) writeProgress({ running: true, stage: Number(m[1]), total: Number(m[2]), label: (m[3] ?? '').trim() })
      }
    })
    child.stderr.on('data', (c: Buffer) => process.stderr.write(c))
    // Settle on 'error' too: a missing interpreter (e.g. python3 not installed)
    // emits 'error' with no 'error' listener → EventEmitter rethrows → the whole
    // process crashes with a stack trace and leaves progress at {running:true}.
    const code: number = await new Promise<number>((resolve) => {
      child.on('error', (err) => {
        process.stderr.write(`failed to start "${sub(setup.command)}": ${err instanceof Error ? err.message : String(err)}\n`)
        resolve(127)   // conventional "command not found"
      })
      child.on('close', (c) => resolve(c ?? 1))
    })
    writeProgress({ running: false, done: true, ok: code === 0, ...(code !== 0 ? { error: `exit ${code}` } : {}) })
    process.exit(code)
  },
})

const pluginSetupStatusCmd = defineCommand({
  meta: { name: 'setup-status', description: 'Emit the last plugin-setup progress (JSON) — polled by the desktop wizard' },
  async run() {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const f = join(STATE_DIR, 'plugin-setup-progress.json')
    if (!existsSync(f)) { console.log(JSON.stringify({ running: false })); return }
    try { console.log(readFileSync(f, 'utf8').trim() || '{}') }
    catch { console.log(JSON.stringify({ running: false, error: 'unreadable progress' })) }
  },
})

const pluginSyncCmd = defineCommand({
  meta: { name: 'sync', description: "Run a plugin's repeatable local refresh action" },
  args: { name: { type: 'positional', required: true, description: 'Plugin name', valueHint: 'name' } },
  async run({ args }) {
    const { loadPlugins } = await import('../../daemon/plugins/registry')
    const { bundledPluginsDir, pluginDataDir } = await import('../../daemon/plugins/paths')
    const { spawn } = await import('node:child_process')
    const { mkdirSync } = await import('node:fs')
    const p = loadPlugins({ stateDir: STATE_DIR, bundledDir: bundledPluginsDir(STATE_DIR) }).find(x => x.name === args.name)
    if (!p) { console.error(`plugin "${args.name}" not found`); process.exit(1) }
    if (!p.enabled || !p.ready) { console.error(`plugin "${args.name}" is not enabled + ready`); process.exit(1) }
    if (!p.manifest.sync) { console.error(`plugin "${args.name}" declares no runnable sync action`); process.exit(1) }
    const dataDir = pluginDataDir(STATE_DIR, p.name)
    mkdirSync(dataDir, { recursive: true })
    const sub = (s: string) => s.split('${pluginDir}').join(p.dir).split('${dataDir}').join(dataDir)
    const action = p.manifest.sync
    const env = { ...process.env, ...Object.fromEntries(Object.entries(action.env ?? {}).map(([k, v]) => [k, sub(v)])) }
    const child = spawn(sub(action.command), (action.args ?? []).map(sub), { env, stdio: 'inherit' })
    const code: number = await new Promise<number>((resolve) => {
      child.on('error', (err) => {
        console.error(`failed to start "${sub(action.command)}": ${err instanceof Error ? err.message : String(err)}`)
        resolve(127)
      })
      child.on('close', (c) => resolve(c ?? 1))
    })
    process.exit(code)
  },
})

// 内置插件来源(2026-09-30):安装包不带一等插件(1747de09),打包版 daemon 靠状态目录里
// 登记的来源找到它们。`self deploy` 从源码 checkout 部署时会自动登记;这里是手动入口。
const pluginSourceCmd = defineCommand({
  meta: { name: 'source', description: 'Show or set where the daemon loads first-party (bundled) plugins from' },
  args: {
    dir: { type: 'positional', required: false, description: 'Plugins dir to register (e.g. <checkout>/plugins)', valueHint: 'dir' },
    json: { type: 'boolean', description: 'JSON output' },
  },
  async run({ args }) {
    const { registerPluginsSource, readPluginsSourcePointer, resolveBundledPlugins } = await import('../../lib/plugins-source')
    if (args.dir) {
      const r = registerPluginsSource(STATE_DIR, args.dir)
      if (args.json) console.log(JSON.stringify(r, null, 2))
      else if (r.ok) console.log(`registered ${r.dir} (${r.plugins.join(', ')}) — restart the daemon to load them`)
      else console.error(`plugin source: ${r.error}`)
      if (!r.ok) process.exit(1)
      return
    }
    const pointer = readPluginsSourcePointer(STATE_DIR)
    const resolved = resolveBundledPlugins(STATE_DIR)
    if (args.json) { console.log(JSON.stringify({ pointer, resolved }, null, 2)); return }
    console.log(`registered source: ${pointer ?? '(none)'}`)
    console.log(resolved ? `this process resolves: ${resolved.dir} (via ${resolved.via})` : 'this process resolves: no bundled plugins dir')
  },
})

export const pluginCmd = defineCommand({
  meta: { name: 'plugin', description: 'Manage plugins (MCP tool providers)' },
  subCommands: { list: pluginListCmd, search: pluginSearchCmd, install: pluginInstallCmd, upgrade: pluginUpgradeCmd, setup: pluginSetupCmd, sync: pluginSyncCmd, 'setup-status': pluginSetupStatusCmd, enable: pluginEnableCmd, disable: pluginDisableCmd, source: pluginSourceCmd },
})
