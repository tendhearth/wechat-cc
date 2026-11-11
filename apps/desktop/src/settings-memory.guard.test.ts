// @vitest-environment happy-dom
// @repo-guard — B3 hierarchy and the generated appearance contract are observable source inputs.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const html = readFileSync('apps/desktop/src/index.html', 'utf8')
const css = readFileSync('apps/desktop/src/styles/settings-memory.css', 'utf8')
const tokens = readFileSync('apps/desktop/src/tokens.css', 'utf8')

describe('B3 setting and memory contract', () => {
  it('reads facts, withdrawals, inference, then raw management without losing protected controls', () => {
    const template = document.createElement('template')
    template.innerHTML = html
    const doc = template.content
    const root = doc.querySelector('#memory-profile-overview')!
    expect(doc.querySelector('#memory-retractions-toggle')!.closest('.memory-sources-panel')).toBeNull()
    for (const id of ['memory-facts-edit', 'memory-retractions-toggle', 'memory-profile-content', 'memory-sources-toggle', 'memory-save-btn', 'memory-cancel-btn']) expect(root.querySelector(`#${id}`)).not.toBeNull()
    expect([...root.children].map(node => node.id || node.className)).toEqual(['memory-facts', 'memory-fold', 'memory-profile-disclosure', 'memory-sources-toggle', 'memory-sources-panel'])
    expect(root.textContent).toContain('最近的决定')
    expect(root.textContent).not.toContain('Claude 的最近决策')
    const drawer = doc.querySelector('#settings-drawer')!
    expect([...drawer.querySelectorAll('.drawer-section > h3')].map(node => node.textContent)).toEqual(['家里的电脑', '偏好', '实验', '项目管理', 'Pro 会员'])
    const confirm = drawer.querySelector('.settings-confirm')!
    expect(confirm.textContent).toContain('停止这台电脑上的 CC')
    expect([...confirm.querySelectorAll('button')].map(node => node.textContent)).toEqual(['取消', '断开连接'])
  })
  it('loads its scoped stylesheet and resolves every appearance variable from the generated B1 contract', () => {
    expect(html).toContain('./styles/settings-memory.css')
    const variables = [...css.matchAll(/var\((--th-[\w-]+)\)/g)].map(match => match[1]!)
    for (const variable of variables) expect(tokens, variable).toContain(`${variable}:`)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    for (const family of ['matter-row-min-height', 'button-radius', 'text-field-search-radius', 'text-field-chat-radius']) expect(css).toContain(`var(--th-${family})`)
  })
})
