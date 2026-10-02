import type {Db} from '../../lib/db'

export interface CreationReceipt {
  id:string;accountId:string;ownerChatId:string;commandHash:string
  projectId:string;path:string;providerId:string;taskId:string;runId:string
  reply:string;createdAt:number
}

const SELECT=`SELECT id,account_id AS accountId,owner_chat_id AS ownerChatId,command_hash AS commandHash,
  project_id AS projectId,path,provider_id AS providerId,task_id AS taskId,run_id AS runId,reply,created_at AS createdAt
  FROM workbench_creation_receipts`
const IMMUTABLE:Array<keyof Omit<CreationReceipt,'createdAt'>>=['id','accountId','ownerChatId','commandHash','projectId','path','providerId','taskId','runId','reply']

export function makeCreationReceiptStore(db:Db) {
  const get=(id:string)=>db.query<CreationReceipt,[string]>(SELECT+' WHERE id=?').get(id)
  return {
    get,
    /** 某个 projectId 下最早的一张回执(手机额度接管用 `quota-handoff:<源任务>` 作键:一件事只交出去一次)。 */
    firstForProject:(projectId:string)=>db.query<CreationReceipt,[string]>(SELECT+' WHERE project_id=? ORDER BY created_at,rowid LIMIT 1').get(projectId),
    add(input:Omit<CreationReceipt,'createdAt'>):CreationReceipt {
      return db.transaction(()=>{
        const prior=get(input.id)
        if(prior) {
          if(IMMUTABLE.some(field=>prior[field]!==input[field]))throw new Error('creation_conflict')
          return prior
        }
        db.query(`INSERT INTO workbench_creation_receipts
          (id,account_id,owner_chat_id,command_hash,project_id,path,provider_id,task_id,run_id,reply,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(input.id,input.accountId,input.ownerChatId,input.commandHash,input.projectId,input.path,input.providerId,input.taskId,input.runId,input.reply,Date.now())
        return get(input.id)!
      })()
    },
  }
}
