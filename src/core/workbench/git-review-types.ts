/** Shared snapshot DTOs without filesystem or persistence dependencies. */
export interface ReviewFile {path:string;preexisting:boolean;kind:'added'|'deleted'|'modified'|'not_reviewed';beforeSha256?:string;afterSha256?:string;diff?:string;reason?:string}
export interface GitReview {version:1;scope:'working-tree-before-after';startedAt:number;finishedAt:number;headBefore:string|null;headAfter:string|null;status:'complete'|'partial'|'unavailable';preexistingPaths:string[];notes:string[];files:ReviewFile[]}
