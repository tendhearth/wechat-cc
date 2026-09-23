import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Options, Settings } from '@anthropic-ai/claude-agent-sdk'
import { isCompanionMcp } from './native-tools'
import { toolInputPreview } from './tool-input-preview'
export { isCompanionMcp } from './native-tools'

export interface NativeClaudeTools {
  servers: NonNullable<Options['mcpServers']>
  omitted: string[]
  omissionReasons?: Record<string, string>
  privateEnvironmentKeys?: string[]
  nativeMcpPolicy?: Pick<Settings, 'allowedMcpServers' | 'deniedMcpServers'>
  disabledPlugins?: Record<string, boolean>
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const names = (value: unknown): string[] => Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
const map = (value: unknown): Record<string, unknown> => object(value) ? value : {}
const stringMap = (value: unknown) => object(value) && Object.values(value).every(v => typeof v === 'string')
const CONFIG_LIMIT = 1_000_000
const PRIVATE_ENV = /^(WECHAT_|HEARTH_|WXVAULT_|WXGRAPH_)/i

function readConfig(path: string): Record<string, unknown> {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > CONFIG_LIMIT) throw Error('invalid config')
    const text = readFileSync(fd, 'utf8')
    if (Buffer.byteLength(text) > CONFIG_LIMIT) throw Error('invalid config')
    const value: unknown = JSON.parse(text)
    if (!object(value)) throw Error('invalid config')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw Error('Claude 的本机工具配置无法读取，请检查配置文件后重试。')
  } finally { if (fd !== undefined) closeSync(fd) }
}
function supportedServer(value: unknown): value is NonNullable<Options['mcpServers']>[string] {
  if (!object(value)) return false
  if (value.type === undefined || value.type === 'stdio') {
    return typeof value.command === 'string' && !!value.command.trim() &&
      (value.args === undefined || (Array.isArray(value.args) && value.args.every(v => typeof v === 'string'))) &&
      (value.env === undefined || stringMap(value.env))
  }
  if (!['http', 'sse'].includes(String(value.type)) || typeof value.url !== 'string' ||
      (value.headers !== undefined && !stringMap(value.headers))) return false
  try { return ['http:', 'https:'].includes(new URL(value.url).protocol) } catch { return false }
}

type McpRule = { serverName: string } | { serverCommand: [string, ...string[]] } | { serverUrl: string }
function readMcpRules(value: unknown): McpRule[] | undefined {
  if (value === undefined) return undefined
  const invalid = () => Error('Claude 的本机工具策略无法读取，请检查配置文件后重试。')
  if (!Array.isArray(value)) throw invalid()
  return value.map(entry => {
    if (!object(entry) || ['serverName', 'serverCommand', 'serverUrl'].filter(key => entry[key] !== undefined).length !== 1) throw invalid()
    if (typeof entry.serverName === 'string') return { serverName: entry.serverName }
    if (typeof entry.serverUrl === 'string') return { serverUrl: entry.serverUrl }
    if (Array.isArray(entry.serverCommand) && entry.serverCommand.length > 0 && entry.serverCommand.every(part => typeof part === 'string')) {
      return { serverCommand: entry.serverCommand as [string, ...string[]] }
    }
    throw invalid()
  })
}
// Normalize DNS only: path/query casing and glob metacharacters remain meaningful.
function normalizePolicyUrl(value: string): string {
  return value.replace(/^([^:/?#]+):\/\/([^/?#]*)/, (_match, scheme: string, authority: string) => {
    const host = authority.replace(/^(.*@)?(\[[^\]]*\]|[^:]*)(:.*)?$/, (_authority, credentials: string | undefined, hostname: string, port: string | undefined) =>
      `${credentials ?? ''}${hostname.toLowerCase().replace(/\.$/, '')}${port ?? ''}`)
    return `${scheme.toLowerCase()}://${host}`
  })
}
function matchesMcpRule(rule: McpRule, name: string, server: Record<string, unknown>): boolean {
  if ('serverName' in rule) return rule.serverName === name
  if ('serverCommand' in rule) {
    if (server.type !== undefined && server.type !== 'stdio') return false
    const command = [server.command, ...names(server.args)]
    return rule.serverCommand.length === command.length && rule.serverCommand.every((part, index) => part === command[index])
  }
  if (!['http', 'sse'].includes(String(server.type)) || typeof server.url !== 'string') return false
  const pattern = normalizePolicyUrl(rule.serverUrl).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${pattern}$`).test(normalizePolicyUrl(server.url))
}
function permitsMcp(name: string, server: Record<string, unknown>, allowed: McpRule[] | undefined, denied: McpRule[]): boolean {
  if (denied.some(rule => matchesMcpRule(rule, name, server))) return false
  if (allowed === undefined) return true
  // Native transport rules take precedence over names, even across settings layers.
  const selector = server.type === undefined || server.type === 'stdio' ? 'serverCommand' : 'serverUrl'
  const transportRules = allowed.filter(rule => selector in rule)
  return (transportRules.length ? transportRules : allowed.filter(rule => 'serverName' in rule))
    .some(rule => matchesMcpRule(rule, name, server))
}

/** Reads config only; no server startup and no authentication changes. */
export function readNativeClaudeTools(cwd: string, environment: NodeJS.ProcessEnv = process.env): NativeClaudeTools {
  const home = environment.HOME || homedir(), configDir = environment.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const global = readConfig(environment.CLAUDE_CONFIG_DIR ? join(configDir, '.claude.json') : join(home, '.claude.json'))
  const local = map(map(global.projects)[cwd])
  const settings = [readConfig(join(configDir, 'settings.json')), readConfig(join(cwd, '.claude/settings.json')), readConfig(join(cwd, '.claude/settings.local.json'))]
  const project = map(readConfig(join(cwd, '.mcp.json')).mcpServers)
  const disabled = new Set([...names(global.disabledMcpServers), ...names(local.disabledMcpServers), ...names(local.disabledMcpjsonServers)])
  const approved = new Set(names(local.enabledMcpjsonServers))
  let allProject = local.enableAllProjectMcpServers === true
  const disabledPlugins: Record<string, boolean> = Object.create(null)
  const privateEnvironmentKeys = new Set<string>(), denied: McpRule[] = []
  let allowed: McpRule[] | undefined
  for (const setting of settings) {
    if (typeof setting.enableAllProjectMcpServers === 'boolean') allProject = setting.enableAllProjectMcpServers
    for (const name of names(setting.disabledMcpjsonServers)) disabled.add(name)
    for (const name of names(setting.enabledMcpjsonServers)) approved.add(name)
    const scopeAllowed = readMcpRules(setting.allowedMcpServers)
    if (scopeAllowed !== undefined) allowed = [...(allowed ?? []), ...scopeAllowed]
    denied.push(...(readMcpRules(setting.deniedMcpServers) ?? []))
    for (const name of Object.keys(map(setting.enabledPlugins))) disabledPlugins[name] = false
    for (const name of Object.keys(map(setting.env))) if (PRIVATE_ENV.test(name)) privateEnvironmentKeys.add(name)
  }
  const omitted = new Set<string>(), eligibleProject: Record<string, unknown> = Object.create(null)
  const omissionReasons: Record<string, string> = Object.create(null)
  for (const [name, server] of Object.entries(project)) {
    if (allProject || approved.has(name)) eligibleProject[name] = server
    else { omitted.add(name); omissionReasons[name] = '尚未在 Claude 中批准' }
  }
  const servers: NativeClaudeTools['servers'] = Object.create(null)
  for (const [name, server] of Object.entries({ ...map(global.mcpServers), ...eligibleProject, ...map(local.mcpServers) })) {
    const reason = isCompanionMcp(name, server) ? '陪伴隔离'
      : disabled.has(name) || map(server).disabled === true || map(server).enabled === false ? '已停用'
      : !/^[A-Za-z0-9_-]+$/.test(name) || !supportedServer(server) ? '不支持的配置'
      : !permitsMcp(name, map(server), allowed, denied) ? '策略限制' : undefined
    if (reason) { omitted.add(name); omissionReasons[name] = reason; continue }
    servers[name] = server as NativeClaudeTools['servers'][string]
    omitted.delete(name); delete omissionReasons[name]
  }
  return {
    servers, omitted: [...omitted], omissionReasons, privateEnvironmentKeys: [...privateEnvironmentKeys], disabledPlugins,
    nativeMcpPolicy: { ...(allowed === undefined ? {} : { allowedMcpServers: allowed }), deniedMcpServers: denied },
  }
}
/** Keep native auth/transport while excluding private channel pointers. */
export function workbenchClaudeEnvironment(overlay: Options['env'] = {}): Options['env'] {
  return Object.fromEntries(Object.entries({ ...process.env, ...overlay }).filter(([name]) => !PRIVATE_ENV.test(name)))
}
/** Preserve reviewable input while redacting recognizable credentials. */
export function nativeMcpInputPreview(input: unknown): string | null {
  return toolInputPreview(input)
}
