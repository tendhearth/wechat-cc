import { readFileSync } from 'node:fs'

export const MOBILE_SRC = new URL('./src/', import.meta.url)
/** daemon 吃的生成物;与 mobile-presence-art.json 同理 —— 编译后的 sidecar 没有源码树。 */
export const MOBILE_PAGE_OUT = new URL('../../src/daemon/mobile-page.generated.json', import.meta.url)

export function readMobileSource(name: string): string {
  const source = readFileSync(new URL(name, MOBILE_SRC), 'utf8')
  if (name !== 'entry.js') return source
  // No ESM or external URL can survive document.write in the relay shell.
  // Read source bytes instead of Function.toString(): Bun and Vitest rewrite
  // function formatting differently, which would drift the generated JSON.
  const contract = readFileSync(new URL('../desktop/src/shared/task-entry-contract.js', import.meta.url), 'utf8')
  const factory = /^export (function createEntryContract\(\) \{[\s\S]*?^\})/m.exec(contract)?.[1]
  if (!factory) throw Error('mobile page: shared entry factory shape changed')
  return `var eContract = (${factory})()\n${source}`
}
