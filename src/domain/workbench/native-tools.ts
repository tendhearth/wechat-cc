const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const map = (value: unknown): Record<string, unknown> => object(value) ? value : {}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
const privateEnvironment = /^(WECHAT_|HEARTH_|WXVAULT_|WXGRAPH_)/i
const privateReference = /(?:WECHAT_|HEARTH_|WXVAULT_|WXGRAPH_)[A-Z_]+/i
const privateIdentity = /(?:wechat[-_]cc|wechat-mcp|wxvault|wxgraph|(?:^|\/)hearth(?:\/|\s|$)|mcp-servers\/(?:wechat|delegate)(?:\/|\s|$)|mcp-server\s+(?:wechat|delegate)(?:\s|$)|\.claude\/channels\/wechat(?:\/|\s|$))/i

/** Match known companion identities, including aliases; ordinary local and
 * third-party memory servers remain eligible for explicit tool approval. */
export function isCompanionMcp(name: string, config: unknown = {}): boolean {
  if (/^(wechat|delegate|hearth|wxvault|wxgraph)(?:[_-]|$)/i.test(name)) return true
  const server = map(config), transport = object(server.transport) ? server.transport : server
  if (Object.keys(map(transport.env)).some(key => privateEnvironment.test(key))) return true
  const references = [
    transport.bearer_token_env_var, ...strings(transport.env_vars),
    ...(Array.isArray(transport.env_vars) ? transport.env_vars.filter(object).map(value => value.name) : []),
    ...Object.values(map(transport.env_http_headers)), ...Object.values(map(transport.headers)),
    ...Object.values(map(transport.http_headers)), ...Object.values(map(transport.env)),
  ].filter((value): value is string => typeof value === 'string')
  if (references.some(value => privateReference.test(value) || privateIdentity.test(value.replaceAll('\\', '/')))) return true
  const launch = [transport.command, ...strings(transport.args), transport.cwd, transport.url, transport.http_headers_helper]
    .filter((value): value is string => typeof value === 'string').join(' ').replaceAll('\\', '/')
  return privateIdentity.test(launch)
}
