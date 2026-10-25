// Persistence-only types: no dependency on execution or artifact readers.
export interface ArtifactSelection {taskId:string;artifactId:string;sha256:string}
export interface ReviewQuote {taskId:string;eventId:number;text:string}
export interface StoredHandoff {
 id:string;sourceTaskId:string;targetTaskId:string;purpose:'review'|'revision';request:string;packetSha256:string;artifactRefsJson:string;quoteJson:string|null;createdAt:number;requestEventId:number|null;sourceNativeId:string|null;targetNativeId:string|null;packetJson:string;tokenHash:string
}
export interface HandoffView extends Omit<StoredHandoff,'artifactRefsJson'|'quoteJson'|'packetJson'|'tokenHash'>{
 artifacts:ArtifactSelection[];quote:ReviewQuote|null;sourceTitle:string;targetTitle:string;sourceProviderId:string;targetProviderId:string;sourceStatus:string;targetStatus:string
}
