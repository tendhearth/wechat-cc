/** Shared storage estimates; budget category is explicit, never inferred from byte counts. */
export const ATTACHMENT_METADATA_BYTES=1024
export const UPLOAD_METADATA_BYTES=16*1024
export const UPLOAD_TOMBSTONE_BYTES=1024

export interface AttachmentBudgetInput {
  id:string;draftId:string;taskId?:string;size:number;sha256:string
  kind:'staged'|'resumable'|'tombstone'
}
