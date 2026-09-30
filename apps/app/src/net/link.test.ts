import { describe, it, expect } from 'vitest'
import { parsePairLink } from './link'

const RID = 'r' + 'abcdefghijklmnopqrstuvwxyz'.slice(0, 26)
const TID = 't' + '0123456789abcdef0123456789abcdef0123'
const TOK = 't' + '0123456789abcdef0123456789abcdef'
const v2 = `https://relay.tendhearth.com/pset/#id=${RID}&t=${TOK}&p=%2Fset&lan=192.168.1.5:51234`

describe('parsePairLink', () => {
  it('官方中继 v2 链接(r… id)⇒ /v2/phone', () => {
    expect(parsePairLink(v2)).toEqual({ ok: true, link: {
      daemonId: RID, linkToken: TOK, relayHost: 'relay.tendhearth.com',
      relayUrl: `wss://relay.tendhearth.com/v2/phone?id=${RID}`, lan: '192.168.1.5:51234',
    } })
  })
  it('老中继(t… id)⇒ /tunnel/phone;带端口的主机保留端口', () => {
    const r = parsePairLink(`https://relay.example.com:8443/pset/#id=${TID}&t=${TOK}&p=%2Fset&lan=10.0.0.2:1`)
    expect(r).toMatchObject({ ok: true, link: { relayHost: 'relay.example.com:8443', relayUrl: `wss://relay.example.com:8443/tunnel/phone?id=${TID}` } })
  })
  it('粘贴时带的空白与换行去掉;参数顺序无关;没有 lan 也行', () => {
    const r = parsePairLink(`  \nhttps://relay.tendhearth.com/pset/#t=${TOK}&id=${RID}\n`)
    expect(r).toMatchObject({ ok: true, link: { daemonId: RID, linkToken: TOK, lan: null } })
  })
  it('百分号编码的值会解码', () => {
    expect(parsePairLink(v2.replace(`id=${RID}`, `id=${encodeURIComponent(RID).replace('a', '%61')}`))).toMatchObject({ ok: true, link: { daemonId: RID } })
  })
  it('电脑没开「出门也能用」时的局域网链接 ⇒ remote_off', () => {
    expect(parsePairLink(`http://192.168.1.5:51234/set?t=${TOK}`)).toEqual({ ok: false, error: 'remote_off' })
  })
  it('不是配对链接 ⇒ not_a_link(随便的文字、别的网址、明文 http 的 pset)', () => {
    for (const s of ['hello', '', 'https://example.com/', `http://relay.tendhearth.com/pset/#id=${RID}&t=${TOK}`, `https://relay.tendhearth.com/other/#id=${RID}&t=${TOK}`]) {
      expect(parsePairLink(s)).toEqual({ ok: false, error: 'not_a_link' })
    }
  })
  it('形状像但内容坏 ⇒ bad_link(缺令牌、id 不合法、令牌不合法、坏的百分号编码)', () => {
    for (const s of [
      `https://relay.tendhearth.com/pset/#id=${RID}`,
      `https://relay.tendhearth.com/pset/#id=xyz&t=${TOK}`,
      `https://relay.tendhearth.com/pset/#id=${RID}&t=d123`,
      `https://relay.tendhearth.com/pset/#id=${RID}&t=${TOK}&lan=%E0%A4%A`,
    ]) expect(parsePairLink(s)).toEqual({ ok: false, error: 'bad_link' })
  })
})
