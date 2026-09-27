/** bun run build:mobile —— 把 apps/mobile/src 组装成 daemon 吃的生成物。改完手机页源码必跑;apps/mobile/build.test.ts 盯着。 */
import { writeFileSync } from 'node:fs'
import { assembleMobilePage, serializeMobilePage } from './assemble'
import { readMobileSource, MOBILE_PAGE_OUT } from './sources'

writeFileSync(MOBILE_PAGE_OUT, serializeMobilePage(assembleMobilePage(readMobileSource)))
console.log(`wrote ${MOBILE_PAGE_OUT.pathname}`)
