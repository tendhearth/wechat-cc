import {expect,it} from 'vitest'
import {openTestDb} from '../../lib/db'
import {makeOwnerDelegationRecorder} from './owner-delegation'
import {ownerConversationWork} from './owner-conversation'
import {makeMatterStore} from '../../adapters/store/matters-store'

it('persists one-shot delegate anchors/results once and never records another owner',()=>{
  const db=openTestDb(),record=makeOwnerDelegationRecorder({db,ownerChatId:()=>'owner',name:()=> 'Codex'})
  expect(record('visitor','codex','private')).toBeNull()
  const finish=record('owner','codex','review this')!
  const first=ownerConversationWork(db,'owner')
  expect(first.references).toHaveLength(1)
  expect(first.references[0]).toMatchObject({kind:'act',messageId:expect.stringMatching(/^delegate:/)})
  expect(makeMatterStore(db).get(first.references[0]!.matterId)?.state).toBe('working')
  finish({ok:true,response:'review complete'});finish({ok:true,response:'duplicate'})
  const next=ownerConversationWork(db,'owner')
  expect(next.references).toEqual(first.references)
  expect(next.results).toHaveLength(1)
  expect(next.results[0]?.text).toBe('review complete')
  expect(ownerConversationWork(db,'visitor')).toMatchObject({references:[],results:[],nextCursor:null})
  db.close()
})
