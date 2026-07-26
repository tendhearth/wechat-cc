import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const shim = readFileSync(join(import.meta.dirname, 'test-shim.ts'), 'utf8')
const mainJs = readFileSync(join(import.meta.dirname, 'src', 'main.js'), 'utf8')

describe('test-shim 接线', () => {
  it('runCli 经 guardCliInvoke 把关(安全阀在唯一的 CLI 出口)', () => {
    expect(shim).toContain("from './dev-guard'")
    const guardIdx = shim.indexOf('guardCliInvoke(')
    const spawnIdx = shim.indexOf("spawn(['bun'")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(spawnIdx)   // 拦在 spawn 之前
  })

  it('热重载已接:模块导入 + handle 分派 + index.html 注入 + watch 启动', () => {
    expect(shim).toContain("from './dev-reload'")
    expect(shim).toContain('makeLiveReload(')
    expect(shim).toContain('.handle(')
    expect(shim).toContain('injectReloadScript(')
    expect(shim).toContain('.watch()')
  })

  it('polyfill 仍守卫真 __TAURI__(tauri dev 指向本 server 的前提)', () => {
    expect(shim).toContain('window.__TAURI__ = window.__TAURI__ ??')
  })

  it('注入 allow-mutations 标记供横幅使用', () => {
    expect(shim).toContain('__WECHAT_CC_ALLOW_MUTATIONS__')
  })
})

describe('横幅三态', () => {
  it('main.js 横幅区分 mock / live / live+可改状态', () => {
    expect(mainJs).toContain('__WECHAT_CC_ALLOW_MUTATIONS__')
    expect(mainJs).toContain('演示模式')          // mock 态文案保留
    expect(mainJs).toContain('可改真实状态')       // allow-mutations 态新文案
  })
})
