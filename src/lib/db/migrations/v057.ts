import type { Migration } from './types'
import { initializeArtifactDeliverySchema } from '../schema-helpers'

// v57 — explicit owner requests for immutable workbench artifact delivery.
export const migration: Migration = (db) => { initializeArtifactDeliverySchema(db) }
