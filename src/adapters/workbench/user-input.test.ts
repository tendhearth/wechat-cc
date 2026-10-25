import {describe,it,expect} from 'vitest'
import {makeRunUserInput,validateUserInputRequest,validateUserInputAnswers} from './user-input'

const request={questions:[{id:'shape',header:'输出',question:'需要哪种格式？',options:[{label:'报告',description:'可阅读'}],allowOther:true}]}
describe('task-owned questions',()=>{
  it('resolves exactly one validated answer and retains immutable pending data',async()=>{
    const broker=makeRunUserInput({taskId:'task-a'})
    const pending=broker.request(request), view=broker.pending()[0]!
    view.questions[0]!.question='changed'
    expect(broker.pending()[0]!.questions[0]!.question).toBe('需要哪种格式？')
    expect(()=>broker.resolve(view.id,{unknown:['报告']})).toThrow('invalid_answer')
    expect(broker.pending()).toHaveLength(1)
    expect(broker.resolve(view.id,{shape:['自定义文件']})).toBe(true)
    expect(await pending).toEqual({shape:['自定义文件']})
    expect(broker.resolve(view.id,{shape:['报告']})).toBe(false)
  })
  it('isolates runs and rejects stale or cancelled callbacks',async()=>{
    const a=makeRunUserInput({taskId:'a'}),b=makeRunUserInput({taskId:'b'}),abort=new AbortController()
    const p=a.request(request,abort.signal),id=a.pending()[0]!.id
    expect(b.resolve(id,{shape:['报告']})).toBe(false)
    abort.abort();expect(await p).toBeNull();expect(a.pending()).toEqual([])
    const other=b.request(request);b.close();expect(await other).toBeNull()
    expect(await b.request(request)).toBeNull()
  })
  it('validates sizes, unique IDs, option constraints and free text',()=>{
    expect(()=>validateUserInputRequest({questions:[]})).toThrow('invalid_question')
    expect(()=>validateUserInputRequest({questions:[...request.questions,...request.questions]})).toThrow('invalid_question')
    expect(()=>validateUserInputRequest({questions:[{...request.questions[0],question:'x'.repeat(4001)}]})).toThrow('invalid_question')
    const strict={questions:[{...request.questions[0]!,allowOther:false}]}
    expect(()=>validateUserInputAnswers(strict,{shape:['other']})).toThrow('invalid_answer')
    expect(()=>validateUserInputAnswers(request,{shape:['a','b']})).toThrow('invalid_answer')
    expect(validateUserInputAnswers(strict,{shape:['报告']})).toEqual({shape:['报告']})
  })
  it('fails closed if the audit cannot persist a question or answer',async()=>{
    const broker=makeRunUserInput({taskId:'a',audit:()=>{throw Error('db offline')}})
    expect(await broker.request(request)).toBeNull();expect(broker.pending()).toEqual([])
  })
})
