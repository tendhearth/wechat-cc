import {expect,it} from 'vitest'
import {PetTurnResponse} from './desktop-api'
const legacy={owner_last_contact_at:null,turn:{phase:'idle',since:null},last_done_at:null,pending_permissions:[]}
it('preserves factual task targets without requiring activities from older daemons',()=>{
 expect(PetTurnResponse.parse(legacy)).toEqual(legacy)
 const activities=[{taskId:'deadbeef',title:'修好排版',phase:'needs_input',detail:'需要确认本地检查',updatedAt:1}]
 expect(PetTurnResponse.parse({...legacy,activities})).toEqual({...legacy,activities})
})
it('rejects malformed task identities and invented activity phases at the response contract',()=>{
 for(const activity of [{taskId:'../deadbeef',title:'x',phase:'working',detail:null,updatedAt:1},{taskId:'deadbeef',title:'x',phase:'unread',detail:null,updatedAt:1}])expect(PetTurnResponse.safeParse({...legacy,activities:[activity]}).success).toBe(false)
})
