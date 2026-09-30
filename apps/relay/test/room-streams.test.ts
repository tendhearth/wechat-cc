import { describe, it, expect } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import { connectDaemon, connectPhone, newIdentity, openDaemonSocket } from './helpers'
import type { Room } from '../src/room'

describe('房间:手机流', () => {
  it('daemon 不在线 ⇒ 手机收 daemon_offline 后被关', async () => {
    const p = await connectPhone(newIdentity().id)
    expect(await p.next()).toEqual({ error: 'daemon_offline' })
    await p.closed
  })

  it('双向转发 + 手机断开通知 daemon', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    p.ws.send(JSON.stringify({ hs: 'pub' }))
    const up = await d.next()
    expect(up).toMatchObject({ frame: { hs: 'pub' } })
    expect(typeof up.stream).toBe('string')
    d.ws.send(JSON.stringify({ stream: up.stream, frame: { hs: 'dpub', v: 2 } }))
    expect(await p.next()).toEqual({ hs: 'dpub', v: 2 })
    p.ws.close(1000)
    expect(await d.next()).toEqual({ stream: up.stream, closed: true })
  })

  it('daemon 发给不存在的流 ⇒ 静默丢(不回错、不崩)', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ stream: 'nope', frame: { x: 1 } }))
    d.ws.send('{"ping":1}')
    expect(await d.next()).toEqual({ pong: 1 })
  })

  it('同一 id 第二条已认证连接替换第一条;旧的被关(4000),新连接收手机帧', async () => {
    const first = await connectDaemon()
    const second = await connectDaemon(first.ident)
    expect(await first.closed).toBe(4000)
    const p = await connectPhone(first.ident.id)
    p.ws.send(JSON.stringify({ hs: 'x' }))
    expect(await second.next()).toMatchObject({ frame: { hs: 'x' } })
  })

  it('僵尸:未认证的冒名 socket 断开,不踢已认证 daemon 的手机', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    const imposter = await openDaemonSocket(d.ident.id)
    await imposter.next()
    imposter.ws.close(1000)
    await imposter.closed
    p.ws.send(JSON.stringify({ hs: 'y' }))
    expect(await d.next()).toMatchObject({ frame: { hs: 'y' } })
  })

  it('当前 daemon 断开 ⇒ 手机收 daemon_offline 并被关', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    d.ws.close(1000)
    expect(await p.next()).toEqual({ error: 'daemon_offline' })
    await p.closed
  })

  it('第 17 条手机流 ⇒ too_many_streams', async () => {
    const d = await connectDaemon()
    for (let i = 0; i < 16; i++) await connectPhone(d.ident.id)
    const extra = await connectPhone(d.ident.id)
    expect(await extra.next()).toEqual({ error: 'too_many_streams' })
  })

  it('手机帧超 512 KiB ⇒ frame_too_large 并关', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    p.ws.send(JSON.stringify({ ct: 'x'.repeat(512 * 1024) }))
    expect(await p.next()).toEqual({ error: 'frame_too_large' })
    expect(await p.closed).toBe(1009)
  })

  it('手机超速(突发 120)⇒ 第 121 帧收 rate_limited 并关', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    for (let i = 0; i < 121; i++) p.ws.send(JSON.stringify({ ct: String(i) }))
    let err: any
    while (!(err = p.msgs.find((m: any) => m.error)) ) await new Promise(r => setTimeout(r, 5))
    expect(err).toEqual({ error: 'rate_limited' })
    expect(await p.closed).toBe(1008)
  })

  it('daemon 帧超 512 KiB ⇒ 回 daemon frame_too_large,连接不关', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ stream: 's', frame: { ct: 'x'.repeat(512 * 1024) } }))
    expect(await d.next()).toEqual({ error: 'frame_too_large' })
    d.ws.send('{"ping":1}')
    expect(await d.next()).toEqual({ pong: 1 })
  })

  it('当天流量只计 daemon→手机:手机上行再多也不耗配额(知道 id 的人刷不爆主人的额度)', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    const chunk = JSON.stringify({ ct: 'x'.repeat(60_000) })
    for (let i = 0; i < 4; i++) { p.ws.send(chunk); await d.next() }
    const late = await connectPhone(d.ident.id)
    late.ws.send(JSON.stringify({ hs: 'ok' }))
    expect(await d.next()).toMatchObject({ frame: { hs: 'ok' } })
    expect(late.msgs).toEqual([])
  })

  it('当天流量超额(测试上限 200000 字节,daemon→手机)⇒ 新手机流 quota_exceeded', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    p.ws.send(JSON.stringify({ hs: 'h' }))
    const up = await d.next()
    const ct = 'x'.repeat(60_000)
    for (let i = 0; i < 4; i++) { d.ws.send(JSON.stringify({ stream: up.stream, frame: { ct } })); await p.next() }
    const late = await connectPhone(d.ident.id)
    expect(await late.next()).toEqual({ error: 'quota_exceeded' })
  })

  it('休眠恢复:清掉内存状态后,流映射从 attachment 重建', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    p.ws.send(JSON.stringify({ hs: 'a' }))
    const up = await d.next()
    const stub = env.ROOM.get(env.ROOM.idFromName(d.ident.id))
    await runInDurableObject<Room, void>(stub, (room) => { room.forgetMemory() })
    d.ws.send(JSON.stringify({ stream: up.stream, frame: { ok: 1 } }))
    expect(await p.next()).toEqual({ ok: 1 })
  })

  it('被拒的第 17 条手机流:随后发的帧不转给 daemon,也不占名额', async () => {
    const d = await connectDaemon()
    for (let i = 0; i < 16; i++) await connectPhone(d.ident.id)
    const extra = await connectPhone(d.ident.id)
    expect(await extra.next()).toEqual({ error: 'too_many_streams' })
    extra.ws.send(JSON.stringify({ leak: 1 }))
    await extra.closed
    d.ws.send('{"ping":7}')
    expect(await d.next()).toEqual({ pong: 7 })   // 先到的若是 {stream,frame} 就会在这里暴露
    expect(d.msgs).toEqual([])
  })

  it('daemon 用 tag 名当 stream(daemon / phone)⇒ 丢,不串到别的 socket', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    d.ws.send(JSON.stringify({ stream: 'daemon', frame: { x: 1 } }))
    d.ws.send(JSON.stringify({ stream: 'phone', frame: { x: 2 } }))
    d.ws.send('{"ping":9}')
    expect(await d.next()).toEqual({ pong: 9 })
    p.ws.send(JSON.stringify({ hs: 'q' }))
    const up = await d.next()
    d.ws.send(JSON.stringify({ stream: up.stream, frame: { legit: 1 } }))
    expect(await p.next()).toEqual({ legit: 1 })
    expect(d.msgs).toEqual([])
  })

  it('daemon 发 {stream, close:true} ⇒ 房间关掉那条手机流并立刻腾出名额', async () => {
    const d = await connectDaemon()
    const phones = []
    for (let i = 0; i < 16; i++) phones.push(await connectPhone(d.ident.id))
    phones[3]!.ws.send(JSON.stringify({ hs: 'bad' }))
    const up = await d.next()
    d.ws.send(JSON.stringify({ stream: up.stream, frame: { error: 'auth_failed' } }))
    d.ws.send(JSON.stringify({ stream: up.stream, close: true }))
    expect(await phones[3]!.next()).toEqual({ error: 'auth_failed' })
    expect(await phones[3]!.closed).toBe(1008)
    const again = await connectPhone(d.ident.id)
    again.ws.send(JSON.stringify({ hs: 'fresh' }))
    expect(await d.next()).toMatchObject({ frame: { hs: 'fresh' } })
    expect(again.msgs).toEqual([])
  })

  it('close 控制帧:tag 名 / 不存在的流 ⇒ 忽略,不关 daemon 也不关别的手机', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    d.ws.send(JSON.stringify({ stream: 'daemon', close: true }))
    d.ws.send(JSON.stringify({ stream: 'phone', close: true }))
    d.ws.send(JSON.stringify({ stream: 'nope', close: true }))
    d.ws.send('{"ping":3}')
    expect(await d.next()).toEqual({ pong: 3 })
    p.ws.send(JSON.stringify({ hs: 'still' }))
    expect(await d.next()).toMatchObject({ frame: { hs: 'still' } })
    expect(p.msgs).toEqual([])
  })
})
