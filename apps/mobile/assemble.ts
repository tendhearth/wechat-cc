/**
 * 把 apps/mobile/src 组装成 daemon 服务的整份文档。纯函数:不碰文件系统、不用 Bun API,
 * bun / node 两个测试运行器都能直接调。
 *
 * 两种标记:
 *   {{>file.js}}   构建期包含,原样内联(页面必须自包含:公网壳页 document.write 整份写入,没有可用的相对路径)
 *   {{UPPER_KEY}}  运行时键,留给 src/daemon/mobile-page.ts 按请求填;只认 RUNTIME_VARS 里的名字
 */
export const RUNTIME_VARS = ['TOKEN_JSON', 'REMOTE_JSON', 'ART_UNLIT_B64', 'ART_LIT_B64', 'BRAND_ICON_VERSION'] as const

export interface MobilePage {
  phone: string
  sw: string
  bootstrap: string
  transport: string
  scripts: { workbench: string; presence: string }
}

const INCLUDE = /\{\{>([a-z-]+\.(?:js|css|html))\}\}/g
// 键名里有数字(ART_LIT_B64):少了 0-9 会让冻结图原封不动地以 {{…}} 送上手机。
const RUNTIME = /\{\{([A-Z0-9_]+)\}\}/g

function expand(name: string, read: (name: string) => string, stack: string[]): string {
  if (stack.includes(name)) throw new Error(`mobile page: include cycle ${[...stack, name].join(' → ')}`)
  return read(name).replace(INCLUDE, (_m, file: string) => expand(file, read, [...stack, name]))
}

export function assembleMobilePage(read: (name: string) => string): MobilePage {
  const page: MobilePage = {
    phone: expand('phone.html', read, []),
    sw: expand('sw.js', read, []),
    bootstrap: expand('bootstrap.html', read, []),
    transport: expand('transport.js', read, []),
    scripts: { workbench: expand('workbench.js', read, []), presence: expand('presence.js', read, []) },
  }
  for (const text of [page.phone, page.sw, page.bootstrap, page.transport, page.scripts.workbench, page.scripts.presence]) {
    for (const m of text.matchAll(RUNTIME)) {
      if (!(RUNTIME_VARS as readonly string[]).includes(m[1]!)) throw new Error(`mobile page: unknown runtime marker {{${m[1]}}}`)
    }
  }
  return page
}

export function serializeMobilePage(page: MobilePage): string {
  return JSON.stringify(page, null, 2) + '\n'
}
