import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api.js', () => ({ invokeApi: vi.fn() }))

beforeEach(() => {
  // @ts-expect-error minimal getElementById stub before import
  globalThis.document = { getElementById: () => null }
  class NodeStub { static TEXT_NODE = 3 }
  // @ts-expect-error stub Node
  globalThis.Node = NodeStub
})

const { renderForageDesk } = await import('./a2a-agents.js')
const { invokeApi } = await import('../api.js')

function fakeEl() {
  return {
    textContent: '', innerHTML: '', hidden: false, disabled: false, title: '',
    dataset: {} as Record<string, string>, childNodes: [] as any[],
    classList: {
      values: new Set<string>(),
      add(c: string) { this.values.add(c) },
      remove(c: string) { this.values.delete(c) },
      toggle(c: string, f?: boolean) { f ? this.values.add(c) : this.values.delete(c) },
      contains(c: string) { return this.values.has(c) },
    },
    setAttribute(k: string, v: string) { (this as any)[k] = v },
    appendChild(n: any) { this.childNodes.push(n); return n },
    querySelector() { return null },
    addEventListener: vi.fn(),
    closest: () => null,
    remove: vi.fn(),
  }
}

function installDom(extra: Record<string, any> = {}) {
  const ids = ['fd-hero-status','fd-wishes','fd-postcards','fd-wishes-count',
    'fd-postcards-count','fd-peers','fd-peers-count','fd-inbound-toggle',
    'fd-inbound-note','fd-social-note','fd-sow',
    'fd-compose','fd-compose-form','fd-compose-topic','fd-compose-city','fd-compose-note','fd-compose-submit','fd-preview',
    'a2a-agents-list','a2a-server-banner',
    'fd-pair-start','fd-pair-accept','fd-pair-code','fd-pair-panel','fd-pair-note','fd-pair-countdown',
    'fd-mailbox','fd-mailbox-count']
  const byId: Record<string, any> = {}
  for (const id of ids) byId[id] = fakeEl()
  Object.assign(byId, extra)
  globalThis.document = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: () => fakeEl(),
  } as unknown as typeof document
  return byId
}

const foragingSeek = { id: 's1', kind: 'seek', topic: '找个会修老相机的师傅', status: 'foraging', hop: 1, peers_asked: 5, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
const echoedSeek   = { id: 's2', kind: 'seek', topic: '转让布偶猫', status: 'echoed', hop: 1, peers_asked: 4, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
const pendingEcho  = { id: 's2:peerX', seek_id: 's2', peer_masked: '三度外的某人', degree: 3, content: '我家布偶刚生了一窝', status: 'pending', created_at: new Date().toISOString() }

describe('renderForageDesk — wishes', () => {
  it('foraging seek renders 觅食中 + pulse + degree bar + peers-asked', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [foragingSeek], echoes: [], inbound: { enabled: false } })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('觅食中')
    expect(html).toContain('fd-pulse')
    expect(html).toContain('fd-deg')
    expect(html).toContain('第 1 度')
    expect(html).toContain('问了 5 个')
    expect(html).toContain('求物求人')     // kind:'seek'
  })

  it('echoed seek renders the 有回音 badge (not the forage ribbon)', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [], inbound: { enabled: false } })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('fd-echo-badge')
    expect(html).toContain('有回音')
    expect(html).not.toContain('fd-pulse')
  })

  it('fun kind renders 朋友间小乐趣 chip', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [{ ...foragingSeek, kind: 'fun' }], echoes: [], inbound: null })
    expect(el['fd-wishes'].innerHTML).toContain('朋友间小乐趣')
  })

  it('empty seeks → warm empty state', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null })
    expect(el['fd-wishes'].innerHTML).toContain('fd-empty')
  })
})

describe('renderForageDesk — postcards', () => {
  it('pending echo renders 揭晓牵线 + masked identity + degree stamp', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [pendingEcho], inbound: null })
    const html = el['fd-postcards'].innerHTML
    expect(html).toContain('揭晓牵线')
    expect(html).toContain('三度外的某人')
    expect(html).toContain('从第 3 度')        // stamp
    expect(html).toContain('data-action="reveal"')
    expect(html).toContain('data-id="s2:peerX"')
    expect(html).toContain('转让布偶猫')        // joined seek topic
  })

  it('revealed echo renders connected treatment (peer_masked now real name)', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [{ ...pendingEcho, status: 'revealed', peer_masked: '老张' }], inbound: null })
    const html = el['fd-postcards'].innerHTML
    expect(html).toContain('老张')
    expect(html).toContain('已牵线')
    expect(html).not.toContain('揭晓牵线')
  })

  it('privacy: render never reads/emits peer_agent_id', () => {
    const el = installDom()
    const dirty = { ...pendingEcho, peer_agent_id: 'SECRET-agent-42' }
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [dirty], inbound: null })
    expect(el['fd-postcards'].innerHTML).not.toContain('SECRET-agent-42')
  })

  it('empty echoes → warm empty state', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null })
    expect(el['fd-postcards'].innerHTML).toContain('fd-empty')
  })
})

describe('renderForageDesk — hero + net', () => {
  it('hero status shows agent count, summed peers-asked, echo count', () => {
    const el = installDom()
    renderForageDesk({
      agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      seeks: [foragingSeek, echoedSeek], echoes: [pendingEcho], inbound: { enabled: true },
    })
    const html = el['fd-hero-status'].innerHTML
    expect(html).toContain('2 位')          // agents.length
    expect(html).toContain('9')             // 5 + 4 peers_asked
    expect(html).toContain('1')             // echoes.length
  })

  it('inbound toggle reflects enabled state', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: { enabled: true } })
    expect(el['fd-inbound-toggle'].classList.contains('fd-on')).toBe(true)
    expect(el['fd-inbound-toggle']['aria-checked']).toBe('true')
  })

  it('inbound off → toggle not lit', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: { enabled: false } })
    expect(el['fd-inbound-toggle'].classList.contains('fd-on')).toBe(false)
  })

  it('peers summary derives avatars from agent names', () => {
    const el = installDom()
    renderForageDesk({ agents: [{ id: 'a', name: '老王' }, { id: 'b', name: '小李' }], seeks: [], echoes: [], inbound: null })
    expect(el['fd-peers'].innerHTML).toContain('王')
    expect(el['fd-peers-count'].textContent).toContain('连着 2 位')
  })

  it('social routes unwired (null) → 未启用 note, agent count still shows', () => {
    const el = installDom()
    renderForageDesk({ agents: [{ id: 'a', name: 'A' }], seeks: null, echoes: null, inbound: null })
    expect(el['fd-social-note'].hidden).toBe(false)
    expect(el['fd-social-note'].textContent).toContain('未启用')
    expect(el['fd-hero-status'].innerHTML).toContain('1 位')
  })
})

describe('reveal action', () => {
  it('connected outcome swaps the card to 已牵线 and removes the buttons', async () => {
    ;(invokeApi as any).mockResolvedValueOnce({ outcome: { state: 'connected' } })
    // Build a card with a reveal button + note + actions, wired via the handler.
    const btn = fakeEl(); btn.dataset.action = 'reveal'; btn.dataset.id = 's2:peerX'
    const actions = fakeEl(); const note = fakeEl()
    const card = { ...fakeEl(), querySelector: (sel: string) => sel === '.fd-pc-actions' ? actions : sel === '.fd-reveal-note' ? note : null }
    ;(btn as any).closest = (sel: string) => sel === '.fd-postcard' ? card : null
    const { __onPostcardActionForTest } = await import('./a2a-agents.js')
    await __onPostcardActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/social/echoes/reveal', { id: 's2:peerX' })
    expect(card.classList.contains('fd-connected')).toBe(true)
    expect(note.textContent).toContain('已牵线')
  })

  it('awaiting_peer outcome collapses actions and shows a wait note', async () => {
    ;(invokeApi as any).mockResolvedValueOnce({ outcome: { state: 'awaiting_peer' } })
    const btn = fakeEl(); btn.dataset.action = 'reveal'; btn.dataset.id = 's2:peerX'
    const actions = fakeEl(); const note = fakeEl()
    const card = { ...fakeEl(), querySelector: (sel: string) => sel === '.fd-pc-actions' ? actions : sel === '.fd-reveal-note' ? note : null }
    ;(btn as any).closest = (sel: string) => sel === '.fd-postcard' ? card : null
    const { __onPostcardActionForTest } = await import('./a2a-agents.js')
    await __onPostcardActionForTest?.({ target: btn } as any)
    expect(note.textContent).toContain('等对方回揭')
    expect(card.classList.contains('fd-connected')).toBe(false)
  })

  it('peer_unreachable outcome re-enables the button with a retry hint', async () => {
    ;(invokeApi as any).mockResolvedValueOnce({ outcome: { state: 'peer_unreachable' } })
    const btn = fakeEl(); btn.dataset.action = 'reveal'; btn.dataset.id = 's2:peerX'
    const note = fakeEl()
    const card = { ...fakeEl(), querySelector: (sel: string) => sel === '.fd-reveal-note' ? note : null }
    ;(btn as any).closest = (sel: string) => sel === '.fd-postcard' ? card : null
    const { __onPostcardActionForTest } = await import('./a2a-agents.js')
    await __onPostcardActionForTest?.({ target: btn } as any)
    expect(btn.disabled).toBe(false)
    expect(note.textContent).toContain('联系不上')
  })

  it('a thrown error surfaces a non-crashing inline note', async () => {
    ;(invokeApi as any).mockRejectedValueOnce(new Error('network down'))
    const btn = fakeEl(); btn.dataset.action = 'reveal'; btn.dataset.id = 's2:peerX'
    const note = fakeEl()
    const card = { ...fakeEl(), querySelector: (sel: string) => sel === '.fd-reveal-note' ? note : null }
    ;(btn as any).closest = (sel: string) => sel === '.fd-postcard' ? card : null
    const { __onPostcardActionForTest } = await import('./a2a-agents.js')
    await expect(__onPostcardActionForTest?.({ target: btn } as any)).resolves.not.toThrow()
    expect(note.textContent).toContain('揭晓失败')
    expect(note.textContent).toContain('network down')
  })
})

describe('inbound toggle', () => {
  it('POSTs the flipped state and surfaces restart-required', async () => {
    ;(invokeApi as any).mockResolvedValueOnce({ enabled: true, restart_required: true })
    const toggle = fakeEl(); const note = fakeEl()
    installDom({ 'fd-inbound-toggle': toggle, 'fd-inbound-note': note })
    const { __onInboundToggleForTest } = await import('./a2a-agents.js')
    await __onInboundToggleForTest?.()
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/social/inbound', { enabled: true })
    expect(toggle.classList.contains('fd-on')).toBe(true)
    expect(note.textContent).toContain('需重启')
  })
})

describe('心愿 compose → propose → preview', () => {
  function composeEvent() {
    return { preventDefault() {}, target: null } as any
  }

  it('propose 成功 → 预览卡只含 redacted,原文不进 DOM', async () => {
    const el = installDom()
    el['fd-compose-topic'].value = '想找会修禄来福来的老师傅,预算两千'
    el['fd-compose-city'].value = '上海'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, intent_id: 'i1', redacted: '【求助】想找懂老相机维修的朋友', redacted_city: '上海' })
    const { __onComposeSubmitForTest } = await import('./a2a-agents.js')
    await __onComposeSubmitForTest?.(composeEvent())
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/social/seek/propose', { topic: '想找会修禄来福来的老师傅,预算两千', city: '上海' })
    const html = el['fd-preview'].innerHTML
    expect(el['fd-preview'].hidden).toBe(false)
    expect(html).toContain('外面只会看到这个')
    expect(html).toContain('【求助】想找懂老相机维修的朋友')
    expect(html).toContain('data-action="seek-confirm"')
    expect(html).toContain('data-action="seek-cancel"')
    expect(html).toContain('data-id="i1"')
    expect(html).not.toContain('禄来福来')          // 隐私锁:原文绝不渲染
  })

  it('topic 为空 → 不发请求,提示先写内容', async () => {
    const el = installDom()
    el['fd-compose-topic'].value = '   '
    ;(invokeApi as any).mockClear()
    const { __onComposeSubmitForTest } = await import('./a2a-agents.js')
    await __onComposeSubmitForTest?.(composeEvent())
    expect((invokeApi as any)).not.toHaveBeenCalled()
    expect(el['fd-compose-note'].textContent).toContain('先写下')
  })

  it('propose 返回 ok:false → reason 落 note', async () => {
    const el = installDom()
    el['fd-compose-topic'].value = '找人'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, reason: 'judge_unavailable' })
    const { __onComposeSubmitForTest } = await import('./a2a-agents.js')
    await __onComposeSubmitForTest?.(composeEvent())
    expect(el['fd-compose-note'].textContent).toContain('judge_unavailable')
  })

  it('503 social_not_wired → social enable 引导文案', async () => {
    const el = installDom()
    el['fd-compose-topic'].value = '找人'
    ;(invokeApi as any).mockRejectedValueOnce(new Error('social_not_wired'))
    const { __onComposeSubmitForTest } = await import('./a2a-agents.js')
    await __onComposeSubmitForTest?.(composeEvent())
    expect(el['fd-compose-note'].textContent).toContain('wechat-cc social enable')
  })

  it('确认派出 → POST confirm 成功后收起 compose 并清空输入', async () => {
    const el = installDom()
    el['fd-compose-topic'].value = 'x'; el['fd-compose-city'].value = 'y'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, intent_id: 'i1' })  // confirm
    ;(invokeApi as any).mockResolvedValue({})                                // refresh 级联
    const btn = fakeEl(); btn.dataset.action = 'seek-confirm'; btn.dataset.id = 'i1'
    const { __onSeekActionForTest } = await import('./a2a-agents.js')
    await __onSeekActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/social/seek/confirm', { id: 'i1' })
    expect(el['fd-compose'].hidden).toBe(true)
    expect(el['fd-compose-topic'].value).toBe('')
  })

  it('取消 → POST cancel 成功后 compose 留着可改,note 提示已取消', async () => {
    const el = installDom()
    el['fd-compose'].hidden = false
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true })
    ;(invokeApi as any).mockResolvedValue({})
    const btn = fakeEl(); btn.dataset.action = 'seek-cancel'; btn.dataset.id = 'i1'
    const { __onSeekActionForTest } = await import('./a2a-agents.js')
    await __onSeekActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/social/seek/cancel', { id: 'i1' })
    expect(el['fd-compose'].hidden).toBe(false)
    expect(el['fd-compose-note'].textContent).toContain('已取消')
  })

  it('confirm 失败(ok:false)→ note 显示原因,按钮恢复可点', async () => {
    const el = installDom()
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, reason: 'not_proposed' })
    const btn = fakeEl(); btn.dataset.action = 'seek-confirm'; btn.dataset.id = 'i1'
    const { __onSeekActionForTest } = await import('./a2a-agents.js')
    await __onSeekActionForTest?.({ target: btn } as any)
    expect(btn.disabled).toBe(false)
    expect(el['fd-compose-note'].textContent).toContain('not_proposed')
  })
})

describe('renderForageDesk — proposed/cancelled 行', () => {
  const proposedSeek = { id: 'i9', kind: 'seek', topic: '原文:找禄来福来维修师傅', status: 'proposed', hop: 1, peers_asked: 0, redacted_topic: '【求助】想找懂老相机维修的朋友', redacted_city: '上海', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }

  it('proposed 行渲染 redacted_topic + 确认/取消按钮,原文不进 DOM', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [proposedSeek], echoes: [], inbound: null })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('【求助】想找懂老相机维修的朋友')
    expect(html).toContain('data-action="seek-confirm"')
    expect(html).toContain('data-action="seek-cancel"')
    expect(html).toContain('data-id="i9"')
    expect(html).toContain('外面只会看到')
    expect(html).not.toContain('禄来福来')            // 隐私锁
    expect(html).not.toContain('觅食中')              // 不是 foraging 视图
  })

  it('proposed 行缺 redacted_topic(老数据)→ 兜底文案,不渲染原文', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [{ ...proposedSeek, redacted_topic: null, redacted_city: null }], echoes: [], inbound: null })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('缺少预览文本')
    expect(html).not.toContain('禄来福来')
  })

  it('cancelled 行灰显,无操作按钮', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [{ ...proposedSeek, status: 'cancelled' }], echoes: [], inbound: null })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('fd-cancelled')
    expect(html).toContain('已取消')
    expect(html).not.toContain('data-action="seek-confirm"')
  })

  it('wishes-count 只计 foraging,不把 proposed 计成在外面', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [proposedSeek, foragingSeek], echoes: [], inbound: null })
    expect(el['fd-wishes-count'].textContent).toContain('1 条在外面')
  })
})

describe('配对面板', () => {
  it('start 成功 → 面板显示 6 位码 + 倒计时文本', async () => {
    const el = installDom()
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [{ id: 'old', name: '旧友' }] })  // 快照
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, code: '277499', expiresAt: Date.now() + 600_000 })
    const { __onPairStartForTest, __stopPairTimersForTest } = await import('./a2a-agents.js')
    await __onPairStartForTest?.()
    __stopPairTimersForTest?.()
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/pair/start')
    expect(el['fd-pair-panel'].hidden).toBe(false)
    expect(el['fd-pair-panel'].innerHTML).toContain('277499')
    expect(el['fd-pair-panel'].innerHTML).toContain('wechat-cc pair 277499')
    expect(el['fd-pair-countdown'].textContent).toContain('有效期还剩')
  })

  it('start relay_drop_failed → 中继文案', async () => {
    const el = installDom()
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [] })
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, reason: 'relay_drop_failed' })
    const { __onPairStartForTest } = await import('./a2a-agents.js')
    await __onPairStartForTest?.()
    expect(el['fd-pair-note'].textContent).toContain('中继')
  })

  it('start 503 pairing_not_wired → social enable 引导', async () => {
    const el = installDom()
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [] })
    ;(invokeApi as any).mockRejectedValueOnce(new Error('pairing_not_wired'))
    const { __onPairStartForTest } = await import('./a2a-agents.js')
    await __onPairStartForTest?.()
    expect(el['fd-pair-note'].textContent).toContain('wechat-cc social enable')
  })

  it('accept 本地校验:非 6 位数字不发请求', async () => {
    const el = installDom()
    el['fd-pair-code'].value = '12ab3'
    ;(invokeApi as any).mockClear()
    const { __onPairAcceptForTest } = await import('./a2a-agents.js')
    await __onPairAcceptForTest?.()
    expect((invokeApi as any)).not.toHaveBeenCalled()
    expect(el['fd-pair-note'].textContent).toContain('6 位数字')
  })

  it('accept 成功 → 显示对方名字并清空输入', async () => {
    const el = installDom()
    el['fd-pair-code'].value = '277499'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, peer: { self_id: 'cc-b', name: '老王的CC' } })
    ;(invokeApi as any).mockResolvedValue({})   // refresh 级联
    const { __onPairAcceptForTest } = await import('./a2a-agents.js')
    await __onPairAcceptForTest?.()
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/pair/accept', { code: '277499' })
    expect(el['fd-pair-note'].textContent).toContain('老王的CC')
    expect(el['fd-pair-code'].value).toBe('')
  })

  it.each([
    ['expired_or_wrong', '码不对或已过期'],
    ['self_pair', '不能和自己'],
    ['id_conflict', '冲突'],
    ['relay_drop_failed', '中继'],
  ])('accept 失败 %s → 人话文案', async (reason, copy) => {
    const el = installDom()
    el['fd-pair-code'].value = '111111'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, reason })
    const { __onPairAcceptForTest } = await import('./a2a-agents.js')
    await __onPairAcceptForTest?.()
    expect(el['fd-pair-note'].textContent).toContain(copy)
  })

  it('checkPairLanded 发现新 agent → 配对成功文案 + 收起面板', async () => {
    const el = installDom()
    el['fd-pair-panel'].hidden = false
    ;(invokeApi as any).mockResolvedValueOnce({ agents: [{ id: 'old' }, { id: 'fresh', name: '小李的CC' }] })
    ;(invokeApi as any).mockResolvedValue({})   // refresh 级联
    const { __checkPairLandedForTest } = await import('./a2a-agents.js')
    await __checkPairLandedForTest?.(new Set(['old']))
    expect(el['fd-pair-note'].textContent).toContain('小李的CC')
    expect(el['fd-pair-panel'].hidden).toBe(true)
  })

  it('accept 成功时清理 start 的 stale 面板/定时器（收起 fd-pair-panel）', async () => {
    const el = installDom()
    el['fd-pair-panel'].hidden = false   // 模拟：自己此前发起过配对，面板还开着、倒计时/轮询还在跑
    el['fd-pair-code'].value = '277499'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true, peer: { self_id: 'cc-b', name: '老王的CC' } })
    ;(invokeApi as any).mockResolvedValue({})   // refresh 级联
    const { __onPairAcceptForTest, __stopPairTimersForTest } = await import('./a2a-agents.js')
    await __onPairAcceptForTest?.()
    expect(el['fd-pair-panel'].hidden).toBe(true)
    __stopPairTimersForTest?.()
  })

  it('start 快照 GET 失败 → fail-closed，不发起 POST /v1/pair/start', async () => {
    const el = installDom()
    ;(invokeApi as any).mockRejectedValueOnce(new Error('network down'))  // 快照失败
    const { __onPairStartForTest } = await import('./a2a-agents.js')
    await __onPairStartForTest?.()
    const calls = (invokeApi as any).mock.calls
    expect(calls.some((c: any[]) => c[0] === 'POST' && c[1] === '/v1/pair/start')).toBe(false)
    expect(el['fd-pair-note'].textContent).toContain('稍后再试')
  })
})

describe('笔友信箱', () => {
  const chan = { id: 'ch1', title: '找修相机师傅', peer_label: '老王的CC', degree: 1, unread: 2, last_preview: '你好呀', last_at: new Date().toISOString() }

  it('信道卡渲染:标题/对端/未读角标/预览;总未读进区块头', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null, mailbox: [chan, { ...chan, id: 'ch2', unread: 0, peer_label: '第2度笔友', title: '' }] })
    const html = el['fd-mailbox'].innerHTML
    expect(html).toContain('老王的CC')
    expect(html).toContain('找修相机师傅')
    expect(html).toContain('fd-mail-unread')
    expect(html).toContain('第2度笔友')
    expect(html).toContain('data-action="mail-toggle"')
    expect(el['fd-mailbox-count'].textContent).toContain('2 封未读')
  })

  it('mailbox:null → 未启用引导;[] → 空态文案', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null, mailbox: null })
    expect(el['fd-mailbox'].innerHTML).toContain('social enable')
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null, mailbox: [] })
    expect(el['fd-mailbox'].innerHTML).toContain('还没有笔友')
  })

  function mailCard() {
    const thread = { ...fakeEl(), hidden: true }
    const badge = fakeEl()
    const bubbles = fakeEl()
    const input = fakeEl(); const note = fakeEl()
    const card = { ...fakeEl(), querySelector: (sel: string) =>
      sel === '.fd-mail-thread' ? thread : sel === '.fd-mail-unread' ? badge :
      sel === '.fd-mail-bubbles' ? bubbles : sel === '.fd-mail-input' ? input :
      sel === '.fd-mail-note' ? note : null }
    return { card, thread, badge, bubbles, input, note }
  }

  it('展开线程:拉信渲染气泡、触发标已读、去掉角标', async () => {
    installDom()
    const { card, thread, badge } = mailCard()
    const btn = fakeEl(); btn.dataset.action = 'mail-toggle'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    ;(invokeApi as any).mockResolvedValueOnce({ letters: [
      { id: 'l2', direction: 'out', plaintext: '我回的', created_at: new Date().toISOString(), read_at: null },
      { id: 'l1', direction: 'in',  plaintext: '你好呀', created_at: new Date().toISOString(), read_at: null },
    ] })
    ;(invokeApi as any).mockResolvedValue({ ok: true })   // read + 后续
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).toHaveBeenCalledWith('GET', '/v1/penpal/letters?channel_id=ch1')
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/penpal/letters/read', { channel_id: 'ch1' })
    expect(thread.hidden).toBe(false)
    expect(thread.innerHTML).toContain('你好呀')
    expect(thread.innerHTML).toContain('fd-out')          // 方向分侧
    expect(thread.innerHTML).toContain('data-action="mail-send"')
    expect(badge.remove).toHaveBeenCalled()
  })

  it('再点收起线程', async () => {
    installDom()
    const { card, thread } = mailCard(); thread.hidden = false; thread.innerHTML = 'x'
    const btn = fakeEl(); btn.dataset.action = 'mail-toggle'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect(thread.hidden).toBe(true)
  })

  it('回信成功:乐观追加气泡、清输入;空文本不发请求', async () => {
    installDom()
    const { card, bubbles, input, note } = mailCard()
    const btn = fakeEl(); btn.dataset.action = 'mail-send'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    input.value = '  '
    ;(invokeApi as any).mockClear()
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).not.toHaveBeenCalled()
    input.value = '这是一封回信'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true })
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/penpal/letters', { channel_id: 'ch1', text: '这是一封回信' })
    expect(bubbles.innerHTML).toContain('这是一封回信')
    expect(input.value).toBe('')
    expect(note.hidden).toBe(true)
  })

  it.each([
    ['channel_not_open', '还没打开'],
    ['no_route', '找不到'],
    ['send_failed', '联系不上'],
  ])('回信失败 %s → 人话文案,按钮恢复', async (error, copy) => {
    installDom()
    const { card, input, note } = mailCard(); input.value = 'x'
    const btn = fakeEl(); btn.dataset.action = 'mail-send'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, error })
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect(note.textContent).toContain(copy)
    expect(btn.disabled).toBe(false)
  })

  it('点击卡头内的子元素(span,无 data-action)也能展开线程 —— closest 走一级', async () => {
    installDom()
    const { card, thread } = mailCard()
    const head = fakeEl(); head.dataset.action = 'mail-toggle'; head.dataset.id = 'ch1'
    ;(head as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    const span = fakeEl()   // 真实浏览器里 e.target 是子 span:没有 dataset.action
    ;(span as any).closest = (sel: string) => sel === '[data-action]' ? head : null
    ;(invokeApi as any).mockResolvedValueOnce({ letters: [] })
    ;(invokeApi as any).mockResolvedValue({ ok: true })
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: span } as any)
    expect(thread.hidden).toBe(false)
    // 清场:收起,复位模块级 openMailThreadEl
    await __onMailboxActionForTest?.({ target: head } as any)
  })

  it('线程展开期间 refresh 不重建信箱块(未寄出的草稿不被吞);收起后恢复重建', async () => {
    const el = installDom()
    const { card, thread } = mailCard()
    const btn = fakeEl(); btn.dataset.action = 'mail-toggle'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    ;(invokeApi as any).mockResolvedValueOnce({ letters: [] })
    ;(invokeApi as any).mockResolvedValue({ ok: true })
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)          // 展开
    expect(thread.hidden).toBe(false)
    el['fd-mailbox'].innerHTML = 'SENTINEL'
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null, mailbox: [chan] })
    expect(el['fd-mailbox'].innerHTML).toBe('SENTINEL')               // 跳过重建
    await __onMailboxActionForTest?.({ target: btn } as any)          // 收起
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null, mailbox: [chan] })
    expect(el['fd-mailbox'].innerHTML).toContain('fd-mail-chan')      // 恢复重建
  })
})
