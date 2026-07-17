# wechat-cc plugins

A plugin gives the desktop agent (Claude / Codex / Cursor) extra capabilities
**without wechat-cc importing a single line of the plugin's code**. The only
coupling is a process boundary + a wire protocol, so a plugin can be written in
any language.

## Two kinds, two contracts

| Kind | Contract | What it is | Agent sees | Status |
|------|----------|------------|------------|--------|
| **`mcp`** | MCP over stdio | A passive tool provider | `mcp__<name>__*` tools | ✅ shipped |
| **`a2a`** | A2A | An autonomous agent peer | a delegate peer | 🔜 reuses this manifest |

Pick `mcp` when your plugin answers queries / performs actions on request
(the common case). `a2a` is only for a plugin that is itself a conversational
agent. Don't wrap a query API as an agent — that's slower and the wrong shape.

## Anatomy of a plugin

A plugin is a **directory** containing a manifest plus whatever the manifest
spawns:

```
example-plugin/
├── wechat-cc.plugin.json     ← the manifest (the only file wechat-cc reads)
├── server.py                 ← the MCP server it spawns
└── …                          ← anything else the server needs
```

### `wechat-cc.plugin.json`

```jsonc
{
  "name": "example-plugin",      // unique; becomes mcp__example-plugin__*  (^[A-Za-z0-9][A-Za-z0-9_-]*$)
  "kind": "mcp",                 // only "mcp" today
  "version": "1.0.0",            // semver; the registry compares it to detect updates
  "minWechatCcVersion": "0.6.4", // host too old → plugin withheld (like engines.vscode)
  "displayName": "Example",
  "description": "…shown in the dashboard…",
  "spawn": {
    "command": "python3",        // resolved via the daemon's PATH
    "args": ["${pluginDir}/server.py"],
    "env": {}                    // optional; values also get ${pluginDir} expansion
  },
  "requires": {                  // free-form operator hints, not enforced
    "setup": "any one-time setup step"
  },
  "tools": ["do_thing", "search"]   // documentation only; MCP is source of truth
}
```

### Repeatable local sync

Plugins backed by a local snapshot may declare a repeatable `sync` spawn next
to the one-time `setup` spawn:

```jsonc
"sync": {
  "command": "python3",
  "args": ["${pluginDir}/sync.py"],
  "env": { "PLUGIN_STATE_DIR": "${dataDir}" }
}
```

This powers `wechat-cc plugin sync <name>` and the desktop「同步最新数据」
button. The action must be safe to repeat and must not redo credential capture.
For status display it may atomically write `${dataDir}/sync-status.json` with
`state`, `running`, `last_success_at`, and `error`. A conversational plugin
should expose the same operation as an MCP tool so a user can request sync by
natural language without opening the desktop app.

`${pluginDir}` expands to the manifest's own directory (absolute). Reserved
names `wechat` and `delegate` are rejected. Your `command` must speak MCP
(JSON-RPC 2.0) over stdio — `initialize`, `tools/list`, `tools/call`.

### Readiness (`healthcheck`)

A plugin often needs setup before its tools work. Declare the paths that must
exist:

```jsonc
"healthcheck": { "requiresPaths": ["${pluginDir}/data/ready"] }
```

If any path is missing the plugin is still **discovered and toggleable**, but
withheld from the agent (`ready: false`) so a broken tool is never handed over.
The `requires.setup` string is surfaced as the fix hint. It's declarative (no
command exec) by design. `minWechatCcVersion` is checked the same way — a host
older than the plugin requires marks it not-ready with an upgrade hint.

## Where plugins live (and the trust model)

Two discovery roots, resolved by `src/daemon/plugins/registry.ts`:

| Root | Path | Distribution | Default state |
|------|------|--------------|---------------|
| **User** | `~/.claude/channels/wechat/plugins/<name>/` | drop-in; **survives upgrades**; third-party | **disabled** |
| **Bundled** | `<repo>/plugins/<name>/` | ships & versions with wechat-cc; first-party; absent in compiled bundles | **enabled** |

User plugins default **disabled** on purpose: a manifest tells the daemon to
`spawn` a process, so *discovery is not consent*. Enable is an explicit
operator action recorded in `~/.claude/channels/wechat/plugins/plugins.json`:

```json
{ "enabled": { "example-plugin": true } }
```

A user plugin overrides a bundled one of the same name. Enable-state and the
plugin folder both live under the user state dir, so a one-click upgrade never
wipes a third-party plugin or its on/off choice. First-party capabilities that
aren't meant for the public market ship as **bundled** plugins (default
enabled) instead of being listed in the registry.

> **Why not `installUserMcp` / `~/.claude.json`?** That path injects into the
> human's *own interactive* Claude CLI globally. Plugins instead inject only
> into the **daemon-spawned** providers (`src/daemon/bootstrap/index.ts`), so
> they're scoped to wechat-cc, toggleable, and never pollute your CLI.

## Installing a plugin

```sh
# 1. drop-in (a plugin is a self-contained folder; symlink for local dev)
ln -sfn /path/to/example-plugin ~/.claude/channels/wechat/plugins/example-plugin
# 2. enable it (records the choice in plugins.json)
wechat-cc plugin enable example-plugin
# 3. restart the daemon — the agent now has mcp__example-plugin__*
```

Manage plugins from the CLI:

```sh
wechat-cc plugin list                 # ● enabled+ready / ○ disabled / not-ready reason
wechat-cc plugin enable <name>
wechat-cc plugin disable <name>
```

## The market (registry)

A curated static JSON index — Obsidian community-plugins.json / Homebrew-tap
style — lists installable **public** plugins. The index holds only POINTERS:
each entry names a git source; the plugin's files live in its own repo,
versioned by tags. Format in `docs/registry.example.json`:

```jsonc
{ "plugins": [{
  "name": "example-plugin", "version": "1.0.0",
  "minWechatCcVersion": "0.6.4",
  "description": "…", "author": "you", "homepage": "…",
  "source": { "type": "git", "url": "https://github.com/you/example-plugin", "ref": "v1.0.0" }
}]}
```

Point wechat-cc at your registry with `WECHAT_CC_PLUGIN_REGISTRY` (an https URL
or a local path; read at call time). Then:

```sh
wechat-cc plugin search [query]       # browse; marks ✓ installed / ⬆ update
wechat-cc plugin install <name>       # git clone into the plugins dir (DISABLED)
wechat-cc plugin enable <name>        # then finish setup + restart the daemon
```

The dashboard「插件」pane shows the same market below the installed list, with
安装 / 更新 / 已安装 buttons. Install = `git clone` the entry's tagged release
into the user plugins dir; it lands **disabled** (trust gate unchanged), and
`update_available` is a strict version-greater check against the installed
manifest. Registry-unavailable degrades to a message, never a hard failure.

## How it wires in (for maintainers)

`buildBootstrap()` calls `loadPlugins()` → `pluginMcpSpecs()` once, then spreads
the resulting `Record<name, McpStdioSpec>` into every provider's `mcpServers`
alongside the core `wechat` + `delegate` children (Claude wants each tagged
`type: 'stdio'`; codex/cursor take the bare `{command,args,env}`). Adding a
provider needs no plugin-side change; adding a plugin needs no bootstrap edit.

Code: `src/daemon/plugins/{manifest,registry,paths}.ts` (+ `registry.test.ts`).
