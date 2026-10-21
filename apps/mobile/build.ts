/**
 * bun run build:mobile —— 把 apps/mobile/src 组装成 daemon 吃的生成物,同时
 * 打包协议层 IIFE(`apps/mobile/src/protocol-generated.js`,挂 `globalThis.CCP`,
 * 手机页 transport.js 与中继壳页 relay/pset.html 都要用)与公网中继壳页
 * (`relay/pset.html`,从 `relay/pset.src.html` 生成)。改了协议包
 * (packages/protocol)、手机页源码(apps/mobile/src)或壳页源码
 * (relay/pset.src.html)都要跑这个;apps/mobile/build.test.ts 盯着三份生成物
 * 跟源码同步。
 *
 * `buildProtocolJs` / `assembleRelayShell` 单独导出给测试用;顶层构建动作用
 * `import.meta.main` 卡住 —— 被 import(测试引用导出函数、或将来别的脚本复用)
 * 时不跑,只有 `bun apps/mobile/build.ts` 直接执行时才写文件。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assembleMobilePage, serializeMobilePage } from './assemble'
import { readMobileSource, MOBILE_PAGE_OUT, CCP_PLACEHOLDER } from './sources'

export const PROTOCOL_ENTRY = new URL('../../packages/protocol/src/browser.ts', import.meta.url)
export const PROTOCOL_JS_OUT = new URL('./src/protocol-generated.js', import.meta.url)
export const PSET_SHELL_SRC = new URL('../../relay/pset.src.html', import.meta.url)
export const PSET_SHELL_OUT = new URL('../../relay/pset.html', import.meta.url)

/**
 * 打包 packages/protocol 的经典脚本入口成一份自包含 IIFE(挂
 * `globalThis.CCP`)。`Bun.build` 是 Bun 专属 API —— 这个函数只在 Bun 下能跑;
 * `apps/mobile/build.test.ts` 的同步守卫因此也只在 Bun 下重新跑一遍比对,
 * Node 作业跳过那一条断言(其余断言照跑)。
 */
export async function buildProtocolJs(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(PROTOCOL_ENTRY)],
    format: 'iife',
    minify: true,
  })
  if (!result.success) {
    throw new Error(`buildProtocolJs: ${result.logs.map(l => String(l.message)).join('; ')}`)
  }
  const text = await result.outputs[0]!.text()
  // 保底加换行,和其它生成物一致;实测 Bun.build 的 iife 输出已经带尾换行。
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * relay/pset.src.html 的占位注释(CCP_PLACEHOLDER,跟 transport.js 顶部那行
 * 是同一个标记,定义在 sources.ts)换成协议 IIFE 源码 —— 纯字符串操作,不用
 * Bun API,bun 和 node 两个 vitest 运行器都能验。
 *
 * 替换值必须走函数形式(`() => protocolJs`),不能直接把字符串传给
 * `String.replace` —— 压缩后的协议 JS 到处是 `$`(minifier 起的短变量名),
 * `String.replace(search, string)` 认 `$&`/`$\`` 这类模式,字符串形式会把
 * 这些片段吃成"匹配前/后的原文"而不是原样插入,产物看着像样、实际错位
 * (同一个坑 apps/mobile/sources.ts 给 transport.js 做替换时也躲开了)。
 */
export function assembleRelayShell(srcHtml: string, protocolJs: string): string {
  if (!srcHtml.includes(CCP_PLACEHOLDER)) {
    throw new Error(`assembleRelayShell: relay/pset.src.html is missing the ${CCP_PLACEHOLDER} placeholder`)
  }
  return srcHtml.replace(CCP_PLACEHOLDER, () => protocolJs)
}

async function main() {
  const protocolJs = await buildProtocolJs()
  writeFileSync(PROTOCOL_JS_OUT, protocolJs)
  console.log(`wrote ${PROTOCOL_JS_OUT.pathname}`)

  writeFileSync(PSET_SHELL_OUT, assembleRelayShell(readFileSync(PSET_SHELL_SRC, 'utf8'), protocolJs))
  console.log(`wrote ${PSET_SHELL_OUT.pathname}`)

  // 手机页生成物依赖 protocol-generated.js 已经落盘(transport.js 顶部的占位
  // 注释要能读到它,见 sources.ts 的 readMobileSource),所以放在最后一步。
  writeFileSync(MOBILE_PAGE_OUT, serializeMobilePage(assembleMobilePage(readMobileSource)))
  console.log(`wrote ${MOBILE_PAGE_OUT.pathname}`)
}

if (import.meta.main) await main()
