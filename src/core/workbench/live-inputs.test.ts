import {it,expect} from 'vitest'
import {openDb} from '../../lib/db'
import {makeWorkbenchStore} from './store'
import {makeLiveInputStore} from './live-inputs'
import {randomUUID} from 'node:crypto'

it('persists idempotent supplements and holds undelivered inputs across restart',()=>{
  const db=openDb({path:':memory:'})
  try{
    const tasks=makeWorkbenchStore(db),task=tasks.create({title:'A',path:'/a',providerId:'claude',ownerChatId:null})
    const store=makeLiveInputStore(db),input={id:randomUUID(),taskId:task.id,runId:randomUUID(),text:'继续检查'}
    expect(store.add(input)).toMatchObject({...input,status:'pending'})
    expect(store.add(input)).toMatchObject({...input,status:'pending'})
    expect(store.list(task.id)).toHaveLength(1)
    expect(()=>store.add({...input,text:'别的指令'})).toThrow('input_conflict')
    store.set(input.id,'sending');store.recover()
    expect(store.get(input.id)?.status).toBe('held')
    expect(store.next(task.id)).toBeNull()
    expect(store.get(input.id)?.text).toBe('继续检查')
  }finally{db.close()}
})
