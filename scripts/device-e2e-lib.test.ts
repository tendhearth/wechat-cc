import { describe, expect, it } from 'vitest'
import { customSchemeLink, humanBlocker, newDeviceIds, parseE2EOut, parseEnvFile, renderReport } from './device-e2e-lib'

describe('device-e2e-lib', () => {
  it('parseE2EOut:只认 E2E_OUT 行,同键后者为准,前面带日志前缀也认', () => {
    const s = 'Test Case started\nE2E_OUT dev_e2e=stash-stashed\r\nE2E_OUT check_code_label=核对码 USZ-YAY\n2026 [x] E2E_OUT status_label=家里的电脑 · 在线\nE2E_OUT status_label=again \nnoise E2E_OUT=bad'
    expect(parseE2EOut(s)).toEqual({ dev_e2e: 'stash-stashed', check_code_label: '核对码 USZ-YAY', status_label: 'again' })
  })
  it('customSchemeLink:https 配对链接换成开发构建认的 tendhearth://;锚点原样保留', () => {
    expect(customSchemeLink('https://relay-staging.tendhearth.com/pset/#id=rabc&t=t00&p=%2Fset&lan=1.2.3.4:5'))
      .toBe('tendhearth://relay-staging.tendhearth.com/pset/#id=rabc&t=t00&p=%2Fset&lan=1.2.3.4:5')
    expect(customSchemeLink('http://192.168.1.2:3000/set?t=t00')).toBeNull()
    expect(customSchemeLink('https://relay.tendhearth.com/pset/')).toBeNull()
  })
  it('newDeviceIds:只算新出现的', () => {
    expect(newDeviceIds([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }, { id: 'a' }])).toEqual(['c'])
  })
  it('parseEnvFile:export / 引号 / 注释 / ~ 展开', () => {
    const home = process.env.HOME
    expect(parseEnvFile('# c\nexport ASC_KEY_ID=ABC\nASC_ISSUER_ID="x-y"\nASC_KEY_PATH=~/.private_keys/k.p8\nX="$HOME/a"\nY=${HOME}/b\nbad line\n'))
      .toEqual({ ASC_KEY_ID: 'ABC', ASC_ISSUER_ID: 'x-y', ASC_KEY_PATH: `${home}/.private_keys/k.p8`, X: `${home}/a`, Y: `${home}/b` })
  })
  it('humanBlocker:锁屏 / 开发者模式 / 信任 ⇒ 给出要主人做的那一件事;别的错误 ⇒ null', () => {
    expect(humanBlocker('error: The device is locked')).toMatch(/解锁/)
    expect(humanBlocker('Developer Mode disabled')).toMatch(/开发者模式/)
    expect(humanBlocker('Please Trust this computer')).toMatch(/信任/)
    expect(humanBlocker('The test runner failed to initialize for UI testing. (Underlying Error: 认证已取消。)')).toMatch(/Enable UI Automation/)
    expect(humanBlocker('error: Swift compile failed')).toBeNull()
  })
  it('renderReport:每步一行,带用时与截图', () => {
    const md = renderReport({ ok: false, startedAt: 't', udid: 'u', outDir: '/o', steps: [{ name: 'pair', ok: false, ms: 1500, detail: 'a|b', screenshot: 'pair.png' }] })
    expect(md).toContain('FAIL')
    expect(md).toContain('| pair | ✗ | 1.5s | a\\|b (截图 pair.png) |')
  })
})
