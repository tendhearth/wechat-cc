/**
 * 手机页模板的运行时填充。生成物里只剩 {{大写键}},daemon 按请求填。
 * 单趟替换 + 函数替换:填进去的值(令牌)即便长得像标记或带 `$&`,也按字面进页面。
 */
const RUNTIME = /\{\{([A-Z0-9_]+)\}\}/g

export function fillMobileTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(RUNTIME, (_m, key: string) => {
    const value = vars[key]
    if (value === undefined) throw new Error(`mobile page template: no value for {{${key}}}`)
    return value
  })
}

/** 塞进 <script> 的 JSON:挡住 `</script>` 提前闭合。与旧 phoneHtml 的写法逐字节一致。 */
export function inlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
