import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { assembleMobilePage, serializeMobilePage } from './assemble'
import { readMobileSource, MOBILE_PAGE_OUT, MOBILE_SRC } from './sources'
import { buildProtocolJs, assembleRelayShell, PROTOCOL_JS_OUT, PSET_SHELL_SRC, PSET_SHELL_OUT } from './build'
import { makeFakeV2Relay } from './fake-v2-relay'
import { makeV2Channel } from '../../packages/protocol/src/index'
import { mobilePhoneHtml } from '../../src/features/phone/mobile-page'

describe('apps/mobile → src/features/phone/mobile-page.generated.json', () => {
  const page = assembleMobilePage(readMobileSource)

  it('generated page is in sync with apps/mobile/src (fix: bun run build:mobile)', () => {
    // 比整份文本:手改生成物、或源文件被编辑器动过,都会在这里红。
    expect(readFileSync(MOBILE_PAGE_OUT, 'utf8')).toBe(serializeMobilePage(page))
  })

  it('sources and the generated JSON check out with LF on every platform (Windows autocrlf would desync the sync test)', () => {
    const paths = [
      'apps/mobile/src/phone.html', 'apps/mobile/src/workbench.js', 'src/features/phone/mobile-page.generated.json',
      'apps/desktop/src/shared/agent-avatars.js', 'apps/desktop/src/shared/agent-avatars.css',
      // 手机协议包 v2 Task 4:三份新生成物,同一个理由(整份文本比对,CRLF 必红)。
      'apps/mobile/src/protocol-generated.js', 'relay/pset.src.html', 'relay/pset.html',
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
    for (const name of ['boot.js', 'transport.js', 'nav.js', 'workbench.js', 'presence.js', 'home.js', 'sw.js']) {
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

  it('the inline page script is syntax-valid and carries no Markdown renderer (收敛 5b:详情只看状态)', () => {
    expect(page.phone).not.toContain('globalThis.CCM=')
    expect(page.phone).not.toContain('@@CCM@@')
    const script=/<script>([\s\S]*?)<\/script>/.exec(page.phone)![1]!
      .replace('{{TOKEN_JSON}}','"fixture"').replace('{{REMOTE_JSON}}','null')
    expect(()=>new Function(script)).not.toThrow()
  })

  it('keeps the inlined agent-avatar factory bytes identical between the production builder and the test runtime',()=>{
    const root=fileURLToPath(new URL('../../',import.meta.url))
    const production=execFileSync('bun',['--eval',"import {readMobileSource} from './apps/mobile/sources.ts'; process.stdout.write(readMobileSource('workbench.js'))"],{cwd:root,encoding:'utf8'})
    expect(production).toBe(readMobileSource('workbench.js'))
  })
})

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

  it('runs a full v2 request through CCP.makeProtocolClient in a vm sandbox that only has crypto.getRandomValues + TextEncoder/TextDecoder + timers — no crypto.subtle at all', async () => {
    const relay = makeFakeV2Relay({ tokens: () => ['device-token'], handler: r => ({ status: 200, body: JSON.stringify({ path: r.path }) }) })
    const sandbox: Record<string, unknown> = {
      crypto: { getRandomValues: (arr: Uint8Array) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr } },
      TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask,
      // 沙箱外的假中继 + daemon(协议包的真密码学),包成协议客户端要的 ProtocolSocket
      __open: () => {
        const ws = new relay.WebSocket('wss://relay.test/v2/phone?id=r1')
        return { send: (s: string) => ws.send(s), close: () => ws.close(), onOpen: (cb: () => void) => { ws.onopen = cb }, onMessage: (cb: (s: string) => void) => { ws.onmessage = ev => cb(ev.data) }, onClose: (cb: () => void) => { ws.onclose = cb } }
      },
    }
    vm.createContext(sandbox)
    vm.runInContext(generated, sandbox)
    expect(typeof (sandbox as any).CCP).toBe('object')
    expect('subtle' in (sandbox.crypto as object)).toBe(false)
    vm.runInContext(`
      globalThis.__res = CCP.makeProtocolClient({ open: __open, token: 'device-token', client: 'web' })
        .request({ method: 'GET', path: '/m/api/home' }).then(function (r) { return r.status + ' ' + r.text() })
      // b64u 也挂在 CCP 上,顺带验一遍 encode/decode 互逆。
      globalThis.__b64u = CCP.b64u.decode(CCP.b64u.encode(new Uint8Array([1, 2, 3, 255])))
    `, sandbox)
    expect(await (sandbox as any).__res).toBe('200 {"path":"/m/api/home"}')
    expect(relay.sockets[0]!.hellos[0]).toMatchObject({ v: [2], client: 'web' })
    expect(Array.from((sandbox as any).__b64u as Uint8Array)).toEqual([1, 2, 3, 255])
  })

  it('the whole /m page still fits in one relay frame once sealed as a v2 res (the pset shell fetches it through the relay)', () => {
    const html = mobilePhoneHtml('d'.repeat(48), { relay: 'wss://relay.tendhearth.com/v2/phone', id: 'r' + 'a'.repeat(26) })
    const key = new Uint8Array(32)
    const msg = JSON.stringify({ t: 'res', rid: 'r'.repeat(36), status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html, bodyEncoding: 'utf8' })
    const wire = JSON.stringify({ stream: 's'.repeat(64), frame: makeV2Channel({ c2s: key, s2c: key }, 'server').seal(new TextEncoder().encode(msg)) })
    // 中继一帧 512 KiB(apps/relay/src/limits.ts);留一半余量给页面以后长大
    expect(Buffer.byteLength(wire, 'utf8')).toBeLessThan(256 * 1024)
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

  it('never calls crypto.subtle — the shell runs before the phone page loads, same CCP client as transport.js', () => {
    const html = readFileSync(PSET_SHELL_OUT, 'utf8')
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
    // 文档注释里提到 "crypto.subtle" 这个词本身没问题(说的是"不再用它");
    // 只看真的会执行的代码调没调 —— 找形如 crypto.subtle. 的属性访问。
    expect(script).not.toMatch(/crypto\s*\.\s*subtle\s*\./)
  })
})
