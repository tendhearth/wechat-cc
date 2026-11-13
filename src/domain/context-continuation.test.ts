import {it,expect} from 'vitest'
import {continuationBlock} from './context-continuation'
it('a long previous answer cannot erase the previous owner words from the carried round',()=>{
 const result=continuationBlock([{dir:'in',text:'刚才那个盒子在书房',ts:'t'},{dir:'out',text:'很长的回答'.repeat(2000),ts:'t'}],[],2048)
 expect(result.block).toContain('刚才那个盒子在书房')
 expect(result.carried).toBe(1)
})
