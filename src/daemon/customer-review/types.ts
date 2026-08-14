/** Stable product-facing types for the Customer Review module. */

export interface CustomerContact {
  /** Stable wxvault conversation username (not the mutable display name). */
  id: string
  displayName: string
  kind: 'private'
  lastMessageAt?: string
  preview?: string
}

export interface CustomerMessage {
  /** App-side deterministic evidence identity until wxvault exposes message ids. */
  evidenceKey: string
  conversationId: string
  /** Local wall-clock time normalized to `YYYY-MM-DDTHH:mm:ss`. */
  time: string
  sender: string
  isFromMe: boolean
  type: string
  text: string
  filePath?: string
}

export interface CustomerMessageQuery {
  contactId: string
  from: string
  to: string
  limit?: number
}

export interface CustomerChatSource {
  searchContacts(query: string): Promise<CustomerContact[]>
  getMessages(input: CustomerMessageQuery): Promise<CustomerMessage[]>
}
