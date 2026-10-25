import {expect,it} from 'vitest'
import {makeExecutionClaims} from './execution-claims'
it('blocks nested projects and the same full native identity even under a different path',()=>{
 const claims=makeExecutionClaims(),a={owner:'one',path:'/project',providerId:'claude',nativeId:'full-native-1'},release=claims.acquire(a)
 expect(claims.conflicts({...a,owner:'two',path:'/other'})).toBe(true)
 expect(claims.conflicts({...a,owner:'two',path:'/project/child',nativeId:'full-native-2'})).toBe(true)
 expect(claims.conflicts({...a,owner:'two',path:'/project-other',nativeId:'full-native-2'})).toBe(false)
 expect(()=>claims.acquire({...a,owner:'two'})).toThrow('native_session_busy');release();release()
 expect(claims.conflicts({...a,owner:'two'})).toBe(false)
})
