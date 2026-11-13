import {it,expect} from 'vitest'
import {continuationBlock} from './context-continuation'
it('a long previous answer cannot erase the previous owner words from the carried round',()=>{
 const result=continuationBlock([{dir:'in',text:'刚才那个盒子在书房',ts:'t'},{dir:'out',text:'很长的回答'.repeat(2000),ts:'t'}],[],2048)
 expect(result.block).toContain('刚才那个盒子在书房')
 expect(result.carried).toBe(1)
})
it('owner continuity keeps six rounds on tiny budgets, clips long text at both ends, and caps the whole block',()=>{
 const recent=Array.from({length:7},(_,i)=>[{dir:'in' as const,text:`原话${i}`,ts:'t'},{dir:'out' as const,text:`开头${i}`+'很长'.repeat(3000)+`结尾${i}`,ts:'t'}]).flat()
 const small=continuationBlock(recent,[],1),large=continuationBlock(recent,[],200000)
 expect(small).toEqual(large);expect(small.carried).toBe(6)
 expect(small.block.length).toBeLessThanOrEqual(12000)
 expect(small.block).not.toContain('原话0');expect(small.block).toContain('原话1')
 expect(small.block).toContain('开头6');expect(small.block).toContain('结尾6');expect(small.block).toContain('省略')
})
it('owner continuity: many proactive bubbles cannot erase owner originals or overflow the character cap',()=>{
 const result=continuationBlock([{dir:'in',text:'主人要保留的那句话',ts:'t'},...Array.from({length:128},(_,i)=>({dir:'out' as const,text:`开头${i}`+'长'.repeat(1000)+`结尾${i}`,source:'speech:agenda',ts:'2026-11-13T00:00:00Z'}))],[],1)
 expect(result.block).toContain('主人要保留的那句话');expect(result.block.length).toBeLessThanOrEqual(12000)
})
