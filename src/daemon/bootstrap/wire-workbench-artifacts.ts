import {makeArtifactDeliveryWorker,type ArtifactDeliveryReceipt} from '../../core/workbench/artifact-deliveries'
import type {WorkbenchService} from '../../core/workbench/service'
import type {IlinkAdapter} from '../ilink-glue'

/** Files are delivered only from an explicit owner request, never from a notification scan. */
export function wireWorkbenchArtifacts(opts:{
  workbench:WorkbenchService
  ilink:Pick<IlinkAdapter,'chatAccountId'|'uploadWorkbenchArtifact'|'sendWorkbenchArtifact'>
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
