import { readFileSync } from 'node:fs'

export const MOBILE_SRC = new URL('./src/', import.meta.url)
/** daemon 吃的生成物;与 mobile-presence-art.json 同理 —— 编译后的 sidecar 没有源码树。 */
export const MOBILE_PAGE_OUT = new URL('../../src/daemon/mobile-page.generated.json', import.meta.url)

export function readMobileSource(name: string): string {
  return readFileSync(new URL(name, MOBILE_SRC), 'utf8')
}
