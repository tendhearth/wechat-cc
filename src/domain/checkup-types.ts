/** Common observation types shared by v0 archives and the versioned interview. */
export interface CheckupTurn {
  /** Final visible prose; fake reply calls remain separate and ordered below. */
  text: string
  replyParts?: Array<{kind:'text'|'reply';text:string}>
  toolCalls: Array<{ name: string; input: unknown }>
  /** A model exhausted its fake-tool loop; infrastructure failures never set this. */
  toolError?: boolean
  usageLimited?: boolean
  firstTextMs: number | null
  durationMs: number
}
