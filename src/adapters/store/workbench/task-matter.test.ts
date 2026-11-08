import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {openDb,type Db} from '../../../lib/db'
import {makeWorkbenchStore} from './store'

/**
 * 一个任务就是一件事(M2):建任务时同一个事务里建它的 matter(同 id、kind=task),出生地只在这一次写。
 * 以前 matter 由服务层事后补(没接 matters 就没有)⇒ 任务的时间线写进 matter_items 之前,这件事可能还不存在。
 */
let db:Db
beforeEach(()=>{db=openDb({path:':memory:'})})
afterEach(()=>db.close())

describe('建任务 = 建这件事',()=>{
  it('同 id、kind=task、标题 / 目录 / 主人照抄,任务指着它',()=>{
    const store=makeWorkbenchStore(db)
    const task=store.create({title:'修登录',path:'/w/app',providerId:'codex',ownerChatId:'owner@im.wechat'})
    expect(db.query('SELECT id,kind,initiator,title,project_path,owner_chat_id,state,origin_matter_id,origin_surface FROM matters WHERE id=?').get(task.id))
      .toEqual({id:task.id,kind:'task',initiator:'owner',title:'修登录',project_path:'/w/app',owner_chat_id:'owner@im.wechat',state:'open',origin_matter_id:null,origin_surface:null})
    expect(store.taskMatterId(task.id)).toBe(task.id)
  })
  it('出生地在建的这一次写进去:从哪次交流、哪条消息、哪个表面',()=>{
    const store=makeWorkbenchStore(db)
    const chat=makeWorkbenchStore(db).create({title:'先有一件',path:'/w',providerId:'claude',ownerChatId:null})
    const task=store.create({title:'被交办的',path:'/w',providerId:'claude',ownerChatId:null,origin:{matterId:chat.id,messageId:'msg-9',surface:'wechat'}})
    expect(db.query('SELECT origin_matter_id,origin_message_id,origin_surface FROM matters WHERE id=?').get(task.id)).toEqual({origin_matter_id:chat.id,origin_message_id:'msg-9',origin_surface:'wechat'})
  })
  it('导入的终端会话:出生地 cli;交接出来的检查任务也有自己的一件事',()=>{
    const store=makeWorkbenchStore(db)
    const imported=store.importSource({providerId:'claude',nativeId:'n-1',cwd:'/w',path:'/w',snapshotSha256:'s',observedFingerprint:'f',truncated:false,snapshotJson:'{}',pagesJson:'[]',title:'导入的',ownerChatId:null,messages:[]})
    expect(db.query('SELECT origin_surface FROM matters WHERE id=?').get(imported.task.id)).toEqual({origin_surface:'cli'})
    const orphans=db.query('SELECT COUNT(*) AS n FROM workbench_tasks WHERE matter_id IS NULL OR matter_id NOT IN (SELECT id FROM matters)').get()
    expect(orphans).toEqual({n:0})
  })
})
