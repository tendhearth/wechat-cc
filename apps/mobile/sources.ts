import { readFileSync } from 'node:fs'
import { renderTokensCss } from '../../packages/design-tokens/src/index'

export const MOBILE_SRC = new URL('./src/', import.meta.url)
/** daemon 吃的生成物;与 mobile-presence-art.json 同理 —— 编译后的 sidecar 没有源码树。 */
export const MOBILE_PAGE_OUT = new URL('../../src/daemon/mobile-page.generated.json', import.meta.url)

/**
 * transport.js(与 relay/pset.src.html)里协议 IIFE 该嵌入的地方。手机协议包
 * v2 Task 4:v1 密封帧改由 packages/protocol 生成的 CCP 算,不再手写
 * WebCrypto。特意写成一句合法的空 JS 注释(`/*...*\/`),不是 apps/mobile 的
 * `{{>file.js}}` 构建期包含语法 —— 那套标记本身不是合法 JS,transport.js 若
 * 直接以 `{{>protocol-generated.js}}` 开头,`tsc -p apps/mobile` 的
 * `checkJs`(把 src/*.js 当真 JS 解析)会在替换之前就报语法错误;写成注释,
 * 替换前(仓库里存的样子)和替换后(真正执行的样子)都是合法 JS。
 */
export const CCP_PLACEHOLDER = '/*@@CCP@@*/'
export const CCM_PLACEHOLDER = '/*@@CCM@@*/'

export function readMobileSource(name: string): string {
  const source = readFileSync(new URL(name, MOBILE_SRC), 'utf8')
  if (name === 'tokens.css') return renderTokensCss() + source
  if (name === 'markdown.js') {
    if (source.split(CCM_PLACEHOLDER).length !== 2) throw Error('mobile page: markdown.js must have exactly one Markdown placeholder')
    const markdownJs = readFileSync(new URL('markdown-generated.js', MOBILE_SRC), 'utf8')
    return source.replace(CCM_PLACEHOLDER, () => `;${markdownJs};\n`)
  }
  if (name === 'transport.js') {
    if (!source.includes(CCP_PLACEHOLDER)) throw Error(`mobile page: transport.js is missing the ${CCP_PLACEHOLDER} placeholder`)
    const protocolJs = readFileSync(new URL('protocol-generated.js', MOBILE_SRC), 'utf8')
    // 函数形式的替换值,不能直接传字符串给 String.replace —— 压缩后的协议 JS
    // 到处是 `$`(minifier 起的短变量名),字符串替换值会把 `$&`/`$\`` 这类
    // 片段当成特殊模式吃掉,产物看着像样、实际错位(build.ts 的
    // assembleRelayShell 踩过一次同款坑,理由写在那边)。
    return source.replace(CCP_PLACEHOLDER, () => protocolJs)
  }
  if (name !== 'entry.js') return source
  // No ESM or external URL can survive document.write in the relay shell.
  // Read source bytes instead of Function.toString(): Bun and Vitest rewrite
  // function formatting differently, which would drift the generated JSON.
  const contract = readFileSync(new URL('../desktop/src/shared/task-entry-contract.js', import.meta.url), 'utf8')
  const factory = /^export (function createEntryContract\(\) \{[\s\S]*?^\})/m.exec(contract)?.[1]
  if (!factory) throw Error('mobile page: shared entry factory shape changed')
  return `var eContract = (${factory})()\n${source}`
}
