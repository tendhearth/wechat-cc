/**
 * wechat-tool-deps.ts — shape definitions for the wechat tool dependencies
 * shared across the daemon. Until P1.B B1 these types lived in
 * src/features/tools.ts as parts of the in-process MCP server's `ToolDeps`
 * struct; that file is now gone (the tools are exclusively served by the
 * standalone wechat-mcp stdio server). Centralising the types here lets
 * ilink-glue and internal-api both speak the same shapes without
 * resurrecting the old tools.ts module.
 *
 * Intentional split between this file and InternalApiDeps in
 * src/daemon/internal-api.ts: the canonical (full) ilink shapes live here;
 * internal-api may carry narrower subsets when only certain methods are
 * used by routes (it doesn't, today — the routes just import these
 * directly — but the option exists).
 */

/** Project registry (alias → cwd path). */
export interface WechatProjectsDep {
  list(): { alias: string; path: string; current: boolean }[]
  switchTo(alias: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
  add(alias: string, path: string): Promise<void>
  remove(alias: string): Promise<void>
}

// 语音口与主动关心开关口搬进了 src/ports/wechat.ts(`WechatVoice` / `WechatCompanionControls`,架构终态 A6)。
