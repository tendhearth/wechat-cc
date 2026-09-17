import {describe,expect,it,vi} from 'vitest'
import {makeUsageMonitor,parseClaudeUsage,parseCodexRateLimits,readClaudeOAuthToken} from './subscription-usage'

/**
 * 订阅额度是**可以读到的**(2026-09-16 主人指出,真机验证):Codex 走 app-server 的
 * `account/rateLimits/read`,Claude 走 `GET https://api.anthropic.com/api/oauth/usage`
 * (用 Claude Code 自己登录的 OAuth 凭据)。两个夹具就是真机当天的返回形状。
 */
const CODEX={rateLimits:{limitId:'codex',limitName:null,primary:{usedPercent:100,windowDurationMins:10080,resetsAt:1789912347},secondary:null,credits:{hasCredits:false,unlimited:false,balance:'0'},planType:'prolite',rateLimitReachedType:'rate_limit_reached'},
  rateLimitsByLimitId:{codex_bengalfox:{limitId:'codex_bengalfox',limitName:'GPT-5.3-Codex-Spark',primary:{usedPercent:0,windowDurationMins:300,resetsAt:1789625860},secondary:{usedPercent:0,windowDurationMins:10080,resetsAt:1790212660},credits:null}}}
const CLAUDE={five_hour:{utilization:12,resets_at:'2026-09-17T03:00:00.361597+00:00'},seven_day:{utilization:18,resets_at:'2026-09-23T00:00:00.361620+00:00'},seven_day_sonnet:null,extra_usage:{utilization:0},limits:{},spend:{}}
const NOW=Date.parse('2026-09-16T20:00:00Z')

describe('parseCodexRateLimits',()=>{
  it('reads plan, windows (minutes → name) and exhaustion from the top-level limit',()=>{
    const s=parseCodexRateLimits(CODEX,NOW)
    expect(s).toMatchObject({providerId:'codex',plan:'prolite',exhausted:true,fetchedAt:NOW})
    expect(s.windows).toEqual([{name:'weekly',usedPercent:100,resetsAt:1789912347_000,durationMins:10080}])
  })
  it('is not exhausted below 100% and tolerates missing pieces',()=>{
    const s=parseCodexRateLimits({rateLimits:{primary:{usedPercent:38,windowDurationMins:300},secondary:{usedPercent:12,windowDurationMins:10080,resetsAt:1790000000}}},NOW)
    expect(s.exhausted).toBe(false);expect(s.plan).toBeNull()
    expect(s.windows).toEqual([{name:'5h',usedPercent:38,resetsAt:null,durationMins:300},{name:'weekly',usedPercent:12,resetsAt:1790000000_000,durationMins:10080}])
    expect(parseCodexRateLimits(null,NOW).windows).toEqual([]);expect(parseCodexRateLimits('junk',NOW).exhausted).toBe(false)
  })
})

describe('parseClaudeUsage',()=>{
  it('reads the 5h / weekly windows and ignores nulls and experiments',()=>{
    const s=parseClaudeUsage(CLAUDE,NOW,'max')
    expect(s).toMatchObject({providerId:'claude',plan:'max',exhausted:false})
    expect(s.windows).toEqual([
      {name:'5h',usedPercent:12,resetsAt:Date.parse('2026-09-17T03:00:00.361597+00:00'),durationMins:300},
      {name:'weekly',usedPercent:18,resetsAt:Date.parse('2026-09-23T00:00:00.361620+00:00'),durationMins:10080},
    ])
  })
  it('flags exhaustion when any tracked window is at 100%',()=>{
    expect(parseClaudeUsage({five_hour:{utilization:100,resets_at:null},seven_day:{utilization:40,resets_at:null}},NOW,null).exhausted).toBe(true)
  })
})

describe('readClaudeOAuthToken',()=>{
  it('prefers the macOS keychain payload and ignores expired tokens',()=>{
    const payload=JSON.stringify({claudeAiOauth:{accessToken:'tok',expiresAt:NOW+60_000,subscriptionType:'max'}})
    expect(readClaudeOAuthToken({platform:'darwin',keychain:()=>payload,readFile:()=>{throw new Error('nope')},now:()=>NOW})).toEqual({token:'tok',plan:'max'})
    const expired=JSON.stringify({claudeAiOauth:{accessToken:'tok',expiresAt:NOW-1,subscriptionType:'max'}})
    expect(readClaudeOAuthToken({platform:'darwin',keychain:()=>expired,readFile:()=>{throw new Error('nope')},now:()=>NOW})).toBeNull()
  })
  it('falls back to ~/.claude/.credentials.json elsewhere and fails soft',()=>{
    const file=JSON.stringify({claudeAiOauth:{accessToken:'tok2',expiresAt:NOW+1}})
    expect(readClaudeOAuthToken({platform:'linux',keychain:()=>{throw new Error('no keychain')},readFile:()=>file,now:()=>NOW})).toEqual({token:'tok2',plan:null})
    expect(readClaudeOAuthToken({platform:'linux',keychain:()=>{throw new Error('x')},readFile:()=>{throw new Error('ENOENT')},now:()=>NOW})).toBeNull()
    expect(readClaudeOAuthToken({platform:'linux',keychain:()=>'',readFile:()=>'not json',now:()=>NOW})).toBeNull()
  })
})

describe('makeUsageMonitor',()=>{
  it('caches per provider for the ttl, refreshes in the background, and never throws',async()=>{
    let t=NOW;const codex=vi.fn(async()=>parseCodexRateLimits(CODEX,t)),claude=vi.fn(async()=>{throw new Error('offline')})
    const m=makeUsageMonitor({sources:{codex,claude},ttlMs:1_000,now:()=>t})
    expect(m.cached('codex')).toBeNull()
    await expect(m.get('codex')).resolves.toMatchObject({exhausted:true})
    await expect(m.get('codex')).resolves.toMatchObject({exhausted:true});expect(codex).toHaveBeenCalledTimes(1)
    t+=2_000
    expect(m.cached('codex')).toMatchObject({exhausted:true})   // 过期也先给旧的,顺手在后台刷新
    await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r))
    expect(codex).toHaveBeenCalledTimes(2)
    await expect(m.get('claude')).resolves.toBeNull();expect(m.cached('claude')).toBeNull()
    await expect(m.get('unknown' as never)).resolves.toBeNull()
  })
})
