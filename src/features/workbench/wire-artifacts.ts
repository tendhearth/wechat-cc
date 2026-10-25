import {makeArtifactDeliveryWorker,type ArtifactDeliveryReceipt} from '../../core/workbench/artifact-deliveries'
import type {WorkbenchService} from './service'
import type {WechatWorkbenchTransport} from '../../ports/wechat'

/**
 * Files are delivered only from an explicit owner request, never from a notification scan.
 * 不经 CC 开口那道门(第三批 3a):这是对主人刚发的「任务 X 文件 <id>」的回话 —— 内容是主人点名的,在处理那条命令时
 * 同步送,送的结果就是回话正文;没有定时、没有扫描、不自动重发。回话那条路不经门(设计稿「明确不做」)。
 */
export function wireWorkbenchArtifacts(opts:{
  workbench:WorkbenchService
  ilink:Pick<WechatWorkbenchTransport,'chatAccountId'|'uploadWorkbenchArtifact'|'sendWorkbenchArtifact'>
}):{close():Promise<void>}{
  const eligible=(receipt:ArtifactDeliveryReceipt)=>opts.workbench.artifactDeliveryEligible(receipt)
    &&opts.ilink.chatAccountId?.(receipt.ownerChatId)===receipt.accountId
  const worker=makeArtifactDeliveryWorker({
    store:opts.workbench.artifactDeliveryStore,
    async load(receipt){
      if(!eligible(receipt))throw Error('artifact_binding_changed')
      return opts.workbench.artifact(receipt.taskId,receipt.artifactId)
    },
    upload(receipt,payload,signal){
      if(!eligible(receipt))return Promise.resolve({status:'blocked',reason:'binding_changed'})
      if(!opts.ilink.uploadWorkbenchArtifact)return Promise.resolve({status:'retryable',reason:'transport_unavailable'})
      return opts.ilink.uploadWorkbenchArtifact({id:receipt.id,ownerChatId:receipt.ownerChatId,accountId:receipt.accountId,name:receipt.name,mime:receipt.mime,bytes:Buffer.from(payload.contentBase64,'base64')},signal)
    },
    send(receipt,item,signal){
      // No await between the final ownership check and the bound transport call.
      if(!eligible(receipt))return Promise.resolve({status:'blocked',reason:'binding_changed'})
      if(!opts.ilink.sendWorkbenchArtifact)return Promise.resolve({status:'deferred',reason:'transport_unavailable'})
      return opts.ilink.sendWorkbenchArtifact(receipt,item,signal)
    },
  })
  opts.workbench.setArtifactDelivery(id=>worker.deliver(id))
  return{async close(){opts.workbench.setArtifactDelivery(undefined);await worker.close()}}
}
