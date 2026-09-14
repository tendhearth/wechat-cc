import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {encodeNativeHistoryKey,type NativeHistoryReader} from './native-history'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
let root:string,db:Db,service:WorkbenchService
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'cc-native-service-'));db=openDb({path:join(root,'test.db')})})
afterEach(async()=>{await service?.shutdown();db.close();rmSync(root,{recursive:true,force:true})})
it('lists and previews only explicitly wired readers without creating or executing tasks',async()=>{
 const registry=createProviderRegistry(),spawn=vi.fn(async()=>{throw new Error('must not execute')}),mint=vi.fn(()=> 'unused')
 registry.register('claude',{spawn},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
 const key=encodeNativeHistoryKey('claude','native-id'),list=vi.fn(async()=>({items:[],nextCursor:null,coverage:'native_supported_history' as const})),read=vi.fn(async()=>({session:{key},messages:[],nextCursor:null}))
 service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:root,ownerChatId:()=>null,mintSessionToken:mint,nativeHistory:{claude:{list,read,currentFingerprint:async()=> 'hash'} as unknown as NativeHistoryReader}})
 expect(service.list().historyProviders).toEqual(['claude'])
 await service.listNativeHistory('claude',{q:'meeting',limit:50});await service.readNativeHistory(key,{limit:100})
 expect(list).toHaveBeenCalledWith({q:'meeting',limit:50});expect(read).toHaveBeenCalledWith(key,{limit:100})
 await expect(service.listNativeHistory('codex',{q:'',limit:50})).rejects.toThrow('native_history_unsupported')
 await expect(service.readNativeHistory(encodeNativeHistoryKey('codex','native-id'),{limit:100})).rejects.toThrow('native_history_unsupported')
 expect(service.list().tasks).toEqual([]);expect(spawn).not.toHaveBeenCalled();expect(mint).not.toHaveBeenCalled()
})
