/**
 * 搬家金标(2026-09-24):把 /m 前端从 src/daemon 的字符串模板搬到 apps/mobile 期间,
 * 服务出去的字节必须一个不差。搬完(计划 Task 5)删掉本文件与夹具。
 * 重新生成:WECHAT_CC_UPDATE_GOLDEN=1 bun --bun vitest run src/daemon/mobile-golden.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { phoneHtml, pageHtml, SW_JS, M_BOOTSTRAP_HTML } from './settings-panel-html'
import art from './mobile-presence-art.json'

const DIR = new URL('./__fixtures__/mobile-golden/', import.meta.url)
const UPDATE = process.env.WECHAT_CC_UPDATE_GOLDEN === '1'
// 两张冻结图共 250KB,有自己的逐字节校验;金标里换回占位,夹具保持可读、可 diff。
const unart = (html: string) => html.split(art.unlit.base64).join('<ART_UNLIT>').split(art.lit.base64).join('<ART_LIT>')

const CASES: Record<string, () => string> = {
  'phone-remote.html': () => unart(phoneHtml('dTOKEN0123456789', { relay: 'wss://relay.example/tunnel/phone', id: 'dev-1' })),
  'phone-lan.html': () => unart(phoneHtml('tTOKEN', null)),
  'phone-hostile.html': () => unart(phoneHtml('</script><script>evil()$&$\'{{ART_LIT_B64}}', null)),
  'set.html': () => pageHtml('tTOKEN'),
  'sw.js': () => SW_JS,
  'bootstrap.html': () => M_BOOTSTRAP_HTML,
}

describe('mobile page golden (byte-identical during the apps/mobile move)', () => {
  for (const [name, render] of Object.entries(CASES)) {
    it(name, () => {
      const got = render()
      if (UPDATE) { mkdirSync(DIR, { recursive: true }); writeFileSync(new URL(name, DIR), got) }
      expect(got).toBe(readFileSync(new URL(name, DIR), 'utf8'))
    })
  }
})
