/** Keep the development task runner's login usable without loading CLI hooks,
 * plugins or unrelated user settings into isolated workbench sessions. */
export function workbenchClaudeAuthEnv(settings: unknown, inherited: NodeJS.ProcessEnv): Record<string,string> {
  const source=settings && typeof settings==='object' && 'env' in settings && settings.env && typeof settings.env==='object'
    ? settings.env as Record<string,unknown> : {}
  const result:Record<string,string>={}
  for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL']) {
    const value=inherited[key] || source[key]
    if (typeof value==='string' && value.trim()) result[key]=value
  }
  return result
}
