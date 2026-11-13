/** Common observation types shared by v0 archives and the v1 interview. */
export interface CheckupTurn {
  text: string
  toolCalls: Array<{ name: string; input: unknown }>
  /** A model exhausted its fake-tool loop; infrastructure failures never set this. */
  toolError?: boolean
  firstTextMs: number | null
  durationMs: number
}
