type Lang = 'zh-Hans' | 'en'

const toolWords = {
  read: { names: ['read', 'readfile', 'view', 'viewfile'], 'zh-Hans': '想看一个文件', en: 'Wants to read a file' },
  list: { names: ['ls', 'listdir', 'listfiles', 'glob'], 'zh-Hans': '想看看文件夹里有什么', en: 'Wants to see what is in a folder' },
  search: { names: ['grep', 'searchfiles'], 'zh-Hans': '想在文件里找东西', en: 'Wants to search within files' },
  url: { names: ['webfetch'], 'zh-Hans': '想打开一个网址', en: 'Wants to open a URL' },
  query: { names: ['websearch', 'searchweb'], 'zh-Hans': '想上网搜一下', en: 'Wants to search the web' },
  delegate: { names: ['task', 'agent', 'spawnagent'], 'zh-Hans': '想派一个帮手去做', en: 'Wants to ask a helper to do something' },
  notebook: { names: ['notebookedit'], 'zh-Hans': '想改一个笔记本', en: 'Wants to edit a notebook' },
}

function withActor(action: string, lang: Lang, actor: string): string {
  return actor ? `${actor} ${lang === 'en' ? action[0]!.toLowerCase() + action.slice(1) : action}` : action
}

/** Native tool names only. An MCP target may use the same name for a different operation. */
export function permissionToolAction(tool: string, lang: Lang, actor = '', mcp?: { server: string; tool: string }): string | undefined {
  if (mcp || /^mcp__/i.test(tool)) return
  const name = tool.toLowerCase().replaceAll('_', '')
  const words = Object.values(toolWords).find(entry => entry.names.includes(name))
  if (words) return withActor(words[lang], lang, actor)
}

export function permissionWebAction(kind: 'url' | 'query', lang: Lang, actor = ''): string {
  return withActor(toolWords[kind][lang], lang, actor)
}
