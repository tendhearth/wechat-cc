import { describe, expect, it } from 'vitest'
import { encodeNativeHistoryKey, decodeNativeHistoryKey, historyCursor, readHistoryCursor, normalizeHistoryList, historyMessage } from './native-history'

describe('native history boundaries',()=>{
  it('round trips full provider identity and rejects path-shaped or cross-provider keys',()=>{
    const key=encodeNativeHistoryKey('claude','session-full-123')
    expect(decodeNativeHistoryKey(key,'claude')).toEqual({providerId:'claude',nativeId:'session-full-123'})
    expect(()=>decodeNativeHistoryKey(key,'codex')).toThrow('invalid_native_history_key')
    for(const id of ['../private','/tmp/session','a.b','', 'x'.repeat(129)])expect(()=>encodeNativeHistoryKey('claude',id)).toThrow('invalid_native_history_key')
    for(const key of ['plain-id','!!','x'.repeat(2049),Buffer.from(JSON.stringify({v:1,providerId:'other',nativeId:'id'})).toString('base64url')])expect(()=>decodeNativeHistoryKey(key)).toThrow('invalid_native_history_key')
  })
  it('binds opaque cursors to provider, query, cwd and read identity',()=>{
    const scope={providerId:'claude',kind:'list',q:'x',cwd:'/fixture'}
    const cursor=historyCursor(scope,500)
    expect(readHistoryCursor(cursor,scope)).toBe(500)
    for(const changed of [{...scope,q:'y'},{...scope,cwd:'/other'},{...scope,providerId:'codex'},{...scope,kind:'read'}])expect(()=>readHistoryCursor(cursor,changed)).toThrow('invalid_cursor')
    for(const cursor of ['', 'bad!', 'x'.repeat(2049)])expect(()=>readHistoryCursor(cursor,scope)).toThrow('invalid_cursor')
    expect(normalizeHistoryList({q:' x ',limit:2,cwd:'/fixture/'})).toEqual({q:'x',limit:2,cwd:'/fixture'})
    for(const limit of [0,101,1.5])expect(()=>normalizeHistoryList({q:'',limit})).toThrow('invalid_request')
    expect(()=>normalizeHistoryList({q:'x'.repeat(201),limit:1})).toThrow('invalid_request')
    expect(()=>normalizeHistoryList({q:'',limit:1,cwd:'relative'})).toThrow('invalid_request')
  })
  it('keeps Markdown and HTML as data, filters harness text and discloses clipping',()=>{
    expect(historyMessage('m','assistant','<script>alert(1)</script> **note**')).toEqual({id:'m',role:'assistant',text:'<script>alert(1)</script> **note**',truncated:false})
    expect(historyMessage('m','user','<environment_context>machine data')).toBeNull()
    expect(historyMessage('m','user','<system-reminder>hidden')).toBeNull()
    expect(historyMessage('m','assistant','x'.repeat(40_001))).toMatchObject({text:'x'.repeat(40_000),truncated:true})
  })
})
