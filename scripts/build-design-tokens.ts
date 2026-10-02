// 重新生成 apps/desktop/src/tokens.css。改了 packages/design-tokens 之后跑一次,把生成物一起提交。
import { writeFileSync } from 'node:fs'
import { renderTokensCss } from '../packages/design-tokens/src/index'
writeFileSync(new URL('../apps/desktop/src/tokens.css', import.meta.url), renderTokensCss())
console.log('wrote apps/desktop/src/tokens.css')
