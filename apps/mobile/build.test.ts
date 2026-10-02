import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { assembleMobilePage, serializeMobilePage } from './assemble'
import { readMobileSource, MOBILE_PAGE_OUT, MOBILE_SRC } from './sources'
import { buildProtocolJs, buildMarkdownJs, escapeInlineMarkdownScript, assembleRelayShell, PROTOCOL_JS_OUT, MARKDOWN_JS_OUT, PSET_SHELL_SRC, PSET_SHELL_OUT } from './build'
import * as serverEntry from '../../src/core/workbench/task-entry'

describe('apps/mobile → src/daemon/mobile-page.generated.json', () => {
  const page = assembleMobilePage(readMobileSource)

  it('generated page is in sync with apps/mobile/src (fix: bun run build:mobile)', () => {
    // 比整份文本:手改生成物、或源文件被编辑器动过,都会在这里红。
    expect(readFileSync(MOBILE_PAGE_OUT, 'utf8')).toBe(serializeMobilePage(page))
  })

  it('sources and the generated JSON check out with LF on every platform (Windows autocrlf would desync the sync test)', () => {
    const paths = [
      'apps/mobile/src/phone.html', 'apps/mobile/src/workbench.js', 'apps/desktop/src/shared/task-entry-contract.js', 'src/daemon/mobile-page.generated.json',
      // 手机协议包 v2 Task 4:三份新生成物,同一个理由(整份文本比对,CRLF 必红)。
      'apps/mobile/src/protocol-generated.js', 'apps/mobile/src/markdown-generated.js', 'relay/pset.src.html', 'relay/pset.html',
    ]
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const out = execFileSync('git', ['check-attr', 'eol', '--', ...paths], { cwd: root, encoding: 'utf8' })
    for (const p of paths) expect(out, p).toContain(`${p}: eol: lf`)
  })

  it('first <script> is bare and defines T — relay/pset.html injects __CC_SHELL__ into it', () => {
    const i = page.phone.indexOf('<script')
    expect(page.phone.slice(i, i + 8)).toBe('<script>')
    expect(page.phone.indexOf('var T = {{TOKEN_JSON}}')).toBeGreaterThan(i)
  })

  it('no script line starts with ( or [ — ASI would glue it onto the previous line as a call/index', () => {
    // 2026-09-24 上类型时踩到:行首 `/** @type {X} */ (el).disabled=…` 会被接成上一行 `})(el)`,运行时 TypeError。
    // transport.js 读的是仓库里手写的原始样子(readFileSync 直读,不走
    // readMobileSource)—— 后者(手机协议包 v2 Task 4 起)会把顶部占位注释
    // 原地换成 protocol-generated.js 那份压缩后的 IIFE,首行天然以 `(` 开头,
    // 那是机器产物自己的 IIFE 包裹,不是这条测试要抓的手写代码 ASI 隐患。
    for (const name of ['boot.js', 'transport.js', 'nav.js', 'workbench.js', 'attachments.js', 'entry.js', 'presence.js', 'you.js', 'home.js', 'sw.js']) {
      const source = name === 'transport.js' ? readFileSync(new URL(name, MOBILE_SRC), 'utf8') : readMobileSource(name)
      const bad = source.split('\n').map((line, i) => [i + 1, line.replace(/\/\*\*.*?\*\/\s*/g, '')] as const)
        .filter(([, line]) => /^\s*[([]/.test(line))
      expect(bad, name).toEqual([])
    }
  })

  it('pulls in no external script or stylesheet — the shell page has no usable origin', () => {
    expect(page.phone).not.toMatch(/<script[^>]*\ssrc=/)
    expect(page.phone).not.toMatch(/<link[^>]*rel="stylesheet"/)
  })

  it('loads the shared Markdown bundle exactly once before the dialogue renderer, inside a syntax-valid inline script', () => {
    expect(page.phone).toContain(readMobileSource('markdown.js'))
    expect(page.phone.match(/globalThis\.CCM=/g)).toHaveLength(1)
    expect(page.phone.indexOf('globalThis.CCM=')).toBeLessThan(page.phone.indexOf('function mRenderEvents'))
    expect(page.phone).not.toContain('@@CCM@@')
    const script=/<script>([\s\S]*?)<\/script>/.exec(page.phone)![1]!
      .replace('{{TOKEN_JSON}}','"fixture"').replace('{{REMOTE_JSON}}','null')
    expect(()=>new Function(script)).not.toThrow()
  })

  it('inlines the same browser-safe entry contract into the classic script without importing runtime modules',()=>{
    const source=readMobileSource('entry.js')
    const contract=new Function('REMOTE','location',source+'\nreturn eContract')(null,{host:'localhost'})
    expect(contract.ENTRY_LIMITS).toEqual(serverEntry.ENTRY_LIMITS)
    const input={text:'要求',context:{excerpts:[{role:'assistant',text:'讨论'}]}}
    expect(contract.composeEntryPrompt(input)).toBe(serverEntry.composeEntryPrompt(input as any))
    expect(contract.entryFailureKind('api_task_attachment_invalid',{surface:'phone',method:'POST',status:400})).toBe('rejected')
    expect(page.phone).toContain(source)
    expect(source).not.toMatch(/^\s*(?:import|export)\s/m)
  })

  it('keeps inline contract bytes identical between the production builder and the test runtime',()=>{
    const root=fileURLToPath(new URL('../../',import.meta.url))
    const production=execFileSync('bun',['--eval',"import {readMobileSource} from './apps/mobile/sources.ts'; process.stdout.write(readMobileSource('entry.js'))"],{cwd:root,encoding:'utf8'})
    expect(production).toBe(readMobileSource('entry.js'))
  })
})

describe('apps/mobile/src/markdown-generated.js', () => {
  const generated=readFileSync(MARKDOWN_JS_OUT,'utf8')

  it.skipIf(!process.versions.bun)('is in sync with packages/markdown/src/browser.ts (fix: bun run build:mobile)', async () => {
    expect(generated).toBe(await buildMarkdownJs())
  })

  it('is self-contained, has no HTML script boundaries, and preserves Markdown rendering in a browser sandbox', () => {
    expect(generated).not.toMatch(/\b(?:import|require)\(/)
    expect(generated).not.toMatch(/<\/script|<!--/i)
    const sandbox=vm.createContext({})
    vm.runInContext(generated,sandbox)
    const api=sandbox.CCM as {renderMarkdown:(s:string)=>string;markdownPlainText:(s:string)=>string}
    expect(api.renderMarkdown('**重点** [文档](https://example.com)')).toContain('<strong>重点</strong>')
    expect(api.renderMarkdown('<script>bad()</script> [坏链接](javascript:bad())')).not.toMatch(/<script|href="javascript:/)
    expect(api.markdownPlainText('**重点** [文档](https://example.com)')).not.toMatch(/\*\*|\]\(/)
  })

  it('escapes HTML parser sentinels without changing JavaScript string and replacement-pattern semantics', () => {
    const source='globalThis.fixture="</ScRiPt><script><!-- $& $1 $$ $`"'
    const escaped=escapeInlineMarkdownScript(source)
    expect(escaped).not.toMatch(/<\/script|<!--/i)
    const sandbox=vm.createContext({})
    vm.runInContext(escaped,sandbox)
    expect(sandbox.fixture).toBe('</ScRiPt><script><!-- $& $1 $$ $`')
  })
})

/**
 * 手机协议包 v2 Task 4:手机页 /m 与中继壳页 relay/pset.html 的 v1 加密改由
 * packages/protocol 生成,不再手写 WebCrypto。apps/mobile/src/protocol-generated.js
 * 是 `Bun.build({ format:'iife' })` 打包 packages/protocol/src/browser.ts 的产物 ——
 * Bun.build 是 Bun 专属 API,只有下面「is in sync」这一条断言用 it.skipIf 在
 * Node 作业上跳过(理由字符串见断言本身);其余断言(LF、无 crypto.subtle、
 * 沙箱往返、relay/pset.html 跟已提交的 protocol-generated.js 一致)两个运行
 * 器都跑。
 */
describe('apps/mobile/src/protocol-generated.js', () => {
  const generated = readFileSync(PROTOCOL_JS_OUT, 'utf8')

  it.skipIf(!process.versions.bun)('is in sync with packages/protocol/src/browser.ts (fix: bun run build:mobile) — Bun.build is Bun-only, this assertion does not run under `npm run test:node`', async () => {
    const fresh = await buildProtocolJs()
    expect(generated).toBe(fresh)
  })

  it('is a single self-contained line that assigns globalThis.CCP and never touches crypto.subtle', () => {
    expect(generated.trim().split('\n')).toHaveLength(1)
    expect(generated).toContain('globalThis.CCP')
    expect(generated).not.toContain('crypto.subtle')
    // 页面自包含(壳页 document.write 整份写入,没有可用的相对路径):不许有外链脚本/样式。
    expect(generated).not.toMatch(/\bimport\(/)
    expect(generated).not.toMatch(/\brequire\(/)
  })

  it('runs a full v1 seal/open round trip in a vm sandbox that only has crypto.getRandomValues + TextEncoder/TextDecoder/atob/btoa — no crypto.subtle at all', () => {
    const sandbox: Record<string, unknown> = {
      crypto: { getRandomValues: (arr: Uint8Array) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr } },
      TextEncoder, TextDecoder, atob, btoa,
    }
    vm.createContext(sandbox)
    vm.runInContext(generated, sandbox)
    expect(typeof (sandbox as any).CCP).toBe('object')
    expect('subtle' in (sandbox.crypto as object)).toBe(false)
    vm.runInContext(`
      var alice = CCP.x25519KeyPair()
      var bob = CCP.x25519KeyPair()
      var sharedFromAlice = CCP.x25519Shared(alice.priv, bob.pub)
      var sharedFromBob = CCP.x25519Shared(bob.priv, alice.pub)
      var keyAlice = CCP.deriveV1Key(sharedFromAlice, 'device-token')
      var keyBob = CCP.deriveV1Key(sharedFromBob, 'device-token')
      var frame = CCP.sealV1(keyAlice, new TextEncoder().encode(JSON.stringify({ path: '/m/api/home', rid: 'r0' })))
      globalThis.__opened = new TextDecoder().decode(CCP.openV1(keyBob, frame))
      // b64u 也挂在 CCP 上,顺带验一遍 encode/decode 互逆。
      globalThis.__b64u = CCP.b64u.decode(CCP.b64u.encode(new Uint8Array([1, 2, 3, 255])))
    `, sandbox)
    expect((sandbox as any).__opened).toBe(JSON.stringify({ path: '/m/api/home', rid: 'r0' }))
    expect(Array.from((sandbox as any).__b64u as Uint8Array)).toEqual([1, 2, 3, 255])
  })
})

describe('relay/pset.html', () => {
  it('is in sync with relay/pset.src.html + the committed protocol-generated.js (fix: bun run build:mobile)', () => {
    const src = readFileSync(PSET_SHELL_SRC, 'utf8')
    const protocolJs = readFileSync(PROTOCOL_JS_OUT, 'utf8')
    expect(readFileSync(PSET_SHELL_OUT, 'utf8')).toBe(assembleRelayShell(src, protocolJs))
  })

  it('inlines the protocol IIFE exactly once — a second literal placeholder-shaped mention would corrupt the middle of it (see transport.js/pset.src.html header comments)', () => {
    const html = readFileSync(PSET_SHELL_OUT, 'utf8')
    expect(html.match(/globalThis\.CCP=/g)).toHaveLength(1)
    expect(html).not.toContain('@@CCP@@')
  })

  it('never calls crypto.subtle — the shell runs before the phone page loads, same v1 CCP as transport.js', () => {
    const html = readFileSync(PSET_SHELL_OUT, 'utf8')
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
    // 文档注释里提到 "crypto.subtle" 这个词本身没问题(说的是"不再用它");
    // 只看真的会执行的代码调没调 —— 找形如 crypto.subtle. 的属性访问。
    expect(script).not.toMatch(/crypto\s*\.\s*subtle\s*\./)
  })
})
