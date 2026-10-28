import type { Migration } from './types'
import { initializeApiSessionSchema } from '../schema-helpers'

// v58 — durable transcripts for managed OpenAI-compatible workbench tasks.
export const migration: Migration = (db) => { initializeApiSessionSchema(db) }
