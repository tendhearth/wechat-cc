import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendIlinkWorkbenchItem,sendIlinkWorkbenchText } from './ilink-workbench'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function fakeResponse(body: string, status = 200): typeof fetch {
  globalThis.fetch = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
  return globalThis.fetch
}

const request = {
  baseUrl: 'https://ilink.invalid/base/',
  token: 'secret-token',
  clientId: 'notice-persistent-1',
  ownerChatId: 'chat-owner',
  text: '任务已完成',
  contextToken: 'context-1',
}

describe('sendIlinkWorkbenchText', () => {
  it.each(['{"errcode":0}', '{"ret":0}', '{"errcode":0,"ret":0}'])('accepts only an explicit numeric success: %s', async body => {
    const fetch = fakeResponse(body) as unknown as ReturnType<typeof vi.fn>
    await expect(sendIlinkWorkbenchText(request)).resolves.toEqual({ status: 'accepted' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://ilink.invalid/base/ilink/bot/sendmessage')
    const wire = JSON.parse(String(init.body))
    expect(wire).toEqual({
      msg: {
        from_user_id: '', client_id: 'notice-persistent-1', to_user_id: 'chat-owner',
        message_type: 2, message_state: 2,
        item_list: [{ type: 1, text_item: { text: '任务已完成' } }],
        context_token: 'context-1',
      },
      base_info: { channel_version: '2.1.7' },
    })
  })

  it.each(['{}', 'not-json', '{"errcode":"0"}', '{"ret":null}', '{"errcode":0,"ret":-2}'])('keeps statusless, malformed, ill-typed, or contradictory replies unknown: %s', async body => {
    fakeResponse(body)
    await expect(sendIlinkWorkbenchText(request)).resolves.toEqual({ status: 'unknown', reason: 'ambiguous_response' })
  })

  it.each([
    ['{"errcode":-2}', { status: 'deferred', reason: 'window_closed' }],
    ['{"errcode":-2,"ret":-2}', { status: 'deferred', reason: 'window_closed' }],
    ['{"ret":-14}', { status: 'blocked', reason: 'account_unavailable' }],
    ['{"errcode":-6}', { status: 'blocked', reason: 'account_unavailable' }],
  ])('maps an unambiguous server refusal %s', async (body, outcome) => {
    fakeResponse(body)
    await expect(sendIlinkWorkbenchText(request)).resolves.toEqual(outcome)
  })

  it.each([500, 503])('makes one request and returns unknown on HTTP %s', async status => {
    const fetch = fakeResponse('server failed', status) as unknown as ReturnType<typeof vi.fn>
    await expect(sendIlinkWorkbenchText(request)).resolves.toEqual({ status: 'unknown', reason: 'transport_uncertain' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('makes one request and returns unknown when the request times out', async () => {
    globalThis.fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    await expect(sendIlinkWorkbenchText({ ...request, timeoutMs: 5 })).resolves.toEqual({ status: 'unknown', reason: 'transport_uncertain' })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('forwards caller abort and keeps a dispatched request unknown', async () => {
    const ctrl = new AbortController()
    globalThis.fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      ctrl.abort()
    })) as unknown as typeof fetch
    await expect(sendIlinkWorkbenchText({ ...request, signal: ctrl.signal })).resolves.toEqual({ status: 'unknown', reason: 'transport_uncertain' })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('sendIlinkWorkbenchItem',()=>{
  const media={encrypt_query_param:'download',aes_key:'YWVz',encrypt_type:1 as const}
  const item={type:4 as const,file_item:{media,file_name:'result.pdf',len:'12'}}
  it('sends exactly one strict media item with the stable receipt id',async()=>{
    const fetch=fakeResponse('{"ret":0}') as unknown as ReturnType<typeof vi.fn>
    await expect(sendIlinkWorkbenchItem({...request,item})).resolves.toEqual({status:'accepted'})
    expect(fetch).toHaveBeenCalledTimes(1);const wire=JSON.parse(String(fetch.mock.calls[0]![1].body))
    expect(wire.msg).toMatchObject({client_id:'notice-persistent-1',to_user_id:'chat-owner',item_list:[item]});expect(wire.msg.item_list).toHaveLength(1)
  })
  it.each(['{}','bad','{"errcode":0,"ret":-2}'])('keeps ambiguous response unknown: %s',async body=>{fakeResponse(body);await expect(sendIlinkWorkbenchItem({...request,item})).resolves.toEqual({status:'unknown',reason:'ambiguous_response'})})
  it('rejects unsupported or incomplete items before network',async()=>{globalThis.fetch=vi.fn() as unknown as typeof fetch;await expect(sendIlinkWorkbenchItem({...request,item:{type:1,text_item:{text:'x'}} as never})).resolves.toEqual({status:'blocked',reason:'invalid_item'});expect(globalThis.fetch).not.toHaveBeenCalled()})
  it('rejects extra payload families before network',async()=>{globalThis.fetch=vi.fn() as unknown as typeof fetch;await expect(sendIlinkWorkbenchItem({...request,item:{...item,text_item:{text:'smuggled'}} as never})).resolves.toEqual({status:'blocked',reason:'invalid_item'});expect(globalThis.fetch).not.toHaveBeenCalled()})
})
