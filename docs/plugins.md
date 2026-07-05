# wechat-cc plugins

A plugin gives the desktop agent (Claude / Codex / Cursor) extra capabilities
**without wechat-cc importing a single line of the plugin's code**. The only
coupling is a process boundary + a wire protocol, so a plugin can be written in
any language. `wxvault` (Python, decrypts + serves your local WeChat history)
is the reference plugin.

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
wxvault/
├── wechat-cc.plugin.json     ← the manifest (the only file wechat-cc reads)
├── wxvault_mcp.py            ← the MCP server it spawns
└── …                          ← anything else the server needs
```

### `wechat-cc.plugin.json`

```jsonc
{
  "name": "wxvault",             // unique; becomes mcp__wxvault__*  (^[A-Za-z0-9][A-Za-z0-9_-]*$)
  "kind": "mcp",                 // only "mcp" today
  "displayName": "微信历史",
  "description": "…shown in the dashboard…",
  "spawn": {
    "command": "python3",        // resolved via the daemon's PATH
    "args": ["${pluginDir}/wxvault_mcp.py"],
    "env": {}                    // optional; values also get ${pluginDir} expansion
  },
  "requires": {                  // free-form operator hints, not enforced
    "ffmpeg": "optional",
    "setup": "run decrypt.py first"
  },
  "tools": ["overview", "search_messages"]   // documentation only; MCP is source of truth
}
```

`${pluginDir}` expands to the manifest's own directory (absolute). Reserved
names `wechat` and `delegate` are rejected. Your `command` must speak MCP
(JSON-RPC 2.0) over stdio — `initialize`, `tools/list`, `tools/call`.

### Readiness (`healthcheck`)

A plugin often needs setup before its tools work (wxvault needs `decrypt.py`
to have produced `out/decrypted`). Declare the paths that must exist:

```jsonc
"healthcheck": { "requiresPaths": ["${pluginDir}/out/decrypted"] }
```

If any path is missing the plugin is still **discovered and toggleable**, but
withheld from the agent (`ready: false`) so a broken tool is never handed over.
The `requires.setup` string is surfaced as the fix hint. It's declarative (no
command exec) by design.

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
{ "enabled": { "wxvault": true } }
```

A user plugin overrides a bundled one of the same name. Enable-state and the
plugin folder both live under the user state dir, so a one-click upgrade never
wipes a third-party plugin or its on/off choice.

> **Why not `installUserMcp` / `~/.claude.json`?** That path injects into the
> human's *own interactive* Claude CLI globally. Plugins instead inject only
> into the **daemon-spawned** providers (`src/daemon/bootstrap/index.ts`), so
> they're scoped to wechat-cc, toggleable, and never pollute your CLI.

## Installing the reference plugin (wxvault)

```sh
# 1. drop-in (a plugin is a self-contained folder; symlink for local dev)
ln -sfn /path/to/wxvault ~/.claude/channels/wechat/plugins/wxvault
# 2. enable it (records the choice in plugins.json)
wechat-cc plugin enable wxvault
# 3. restart the daemon — the agent now has mcp__wxvault__{overview,search_messages,…}
```

Manage plugins from the CLI:

```sh
wechat-cc plugin list                 # ● enabled+ready / ○ disabled / not-ready reason
wechat-cc plugin enable <name>
wechat-cc plugin disable <name>
```

## How it wires in (for maintainers)

`buildBootstrap()` calls `loadPlugins()` → `pluginMcpSpecs()` once, then spreads
the resulting `Record<name, McpStdioSpec>` into every provider's `mcpServers`
alongside the core `wechat` + `delegate` children (Claude wants each tagged
`type: 'stdio'`; codex/cursor take the bare `{command,args,env}`). Adding a
provider needs no plugin-side change; adding a plugin needs no bootstrap edit.

Code: `src/daemon/plugins/{manifest,registry,paths}.ts` (+ `registry.test.ts`).
