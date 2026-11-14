import z from 'zod'

/** Existing entry contract: UUID versions 1–5 with an RFC variant; never trim external keys. */
export const ENTRY_REQUEST_ID_PATTERN=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export const EntryRequestId=z.string().regex(ENTRY_REQUEST_ID_PATTERN)
