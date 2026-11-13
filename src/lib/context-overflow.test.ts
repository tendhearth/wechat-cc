import {it,expect} from 'vitest'
import {isContextOverflow} from './provider-error-code'
import {openaiErrorCode} from '../adapters/executors/openai/openai-error-code'
import {claudeApiFailure,claudeResultFailure} from '../adapters/executors/claude/claude-sdk-messages'
import {codexAppServerErrorCode} from '../adapters/executors/codex/codex-errors'
it('classifies provider context failures in one place without confusing output, quota or rate limits',()=>{
 for(const e of ['prompt is too long: 210000 tokens', {code:'context_length_exceeded'}, {status:400,message:'maximum context length is 32768 tokens'}, {name:'ContextWindowExceededError'}, {errors:[{responseBody:JSON.stringify({error:{code:'context_length_exceeded'}})}]}])expect(isContextOverflow(e)).toBe(true)
 for(const e of ['max_tokens exceeded','rate limit exceeded','quota exceeded', {status:400,message:'invalid model'}, {status:429,message:'rate limit'}])expect(isContextOverflow(e)).toBe(false)
 expect(openaiErrorCode({statusCode:400,responseBody:JSON.stringify({error:{code:'context_length_exceeded',message:'too many tokens'}})})).toBe('context_overflow')
 expect(openaiErrorCode(Object.assign(new Error('gateway error'),{name:'ContextWindowExceededError'}))).toBe('context_overflow')
 expect(claudeApiFailure('invalid_request','prompt is too long',400).code).toBe('context_overflow')
 expect(claudeResultFailure({is_error:true,subtype:'success',result:'prompt is too long'})?.code).toBe('context_overflow')
 expect(codexAppServerErrorCode({codexErrorInfo:'contextWindowExceeded'})).toBe('context_overflow')
})
