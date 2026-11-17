import {it,expect} from 'vitest'
import {isContextOverflow,contextOverflowInputTokens,contextOverflowLimitTokens,codeForHttpStatus} from './provider-error-code'

export const gatewayOverflow='litellm.BadRequestError: OpenAIException - Invalid request: Your request exceeded model token limit: 262144 (requested: 319507). Received Model Group=Kimi-Code'
for(const message of [gatewayOverflow,'maximum context length is 32000 tokens','context window exceeded','context window is 32000 tokens','context window size is 32000 tokens','context window limit reached','prompt is too long','input is too long','input too long for the model','too many tokens'])it(`classifies upstream overflow: ${message}`,()=>{
  expect(isContextOverflow({error:{message}})).toBe(true)
})
it('parses limit independently of requested (including the real LiteLLM colon)',()=>{
  expect(contextOverflowInputTokens(gatewayOverflow)).toBe(319507)
  expect(contextOverflowLimitTokens(gatewayOverflow)).toBe(262144)
  expect(contextOverflowLimitTokens('maximum context length is 32,000 tokens; requested 33,000 tokens')).toBe(32000)
  expect(contextOverflowLimitTokens('context window: 8192 tokens')).toBe(8192)
  expect(isContextOverflow({message:'context window size 32000 tokens; requested: 33000'})).toBe(true)
  expect(contextOverflowLimitTokens('context window size 32000 tokens; requested: 33000')).toBe(32000)
  expect(contextOverflowInputTokens('too many tokens')).toBeUndefined()
})
it('does not interpret a token-per-minute 429 as a context limit or persist its requested count',()=>{
  const text='Too many tokens requested; requested: 1200; tokens-per-minute limit reached'
  expect(isContextOverflow({message:text})).toBe(false)
  expect(codeForHttpStatus(429,text)).toBe('rate_limited')
  expect(isContextOverflow({code:'rate_limited',message:'maximum context length is 32000 tokens'})).toBe(false)
})
for(const message of ['max_tokens exceeds output token limit','insufficient quota','rate limit exceeded','too many tokens per minute','Please set the context window in settings'])it(`does not call unrelated errors overflow: ${message}`,()=>{
  expect(isContextOverflow({message})).toBe(false)
})
