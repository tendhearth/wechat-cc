// @ts-check
// Metadata validation is NOT image recognition. See cc-v1/README.md visual gate.
import { ANATOMY } from '../../assets/pet/cc-v1/placeholder.js'

export const CC_ART_STATUSES = Object.freeze(['normative-placeholder', 'production-candidate', 'reviewed-production'])

/** @param {any} raw @returns {string[]} */
export function validateCCMetadata(raw) {
  const errors = []
  for (const [key, value] of Object.entries(ANATOMY)) {
    if (raw?.character?.[key] !== value) errors.push(`character:${key}`)
  }
  if (raw?.character?.sameGeometry !== true) errors.push('character:sameGeometry')
  const a = raw?.forms?.lit?.geometryId, b = raw?.forms?.unlit?.geometryId
  if (typeof a !== 'string' || !a || a !== b) errors.push('character:geometryId')
  if (raw?.forms?.lit?.material?.intrinsicGlow !== true) errors.push('material:lit:intrinsicGlow')
  if (raw?.forms?.unlit?.material?.intrinsicGlow !== false) errors.push('material:unlit:intrinsicGlow')
  const status = (/** @type {any} */ entry, /** @type {string} */ label) => {
    if (!CC_ART_STATUSES.includes(entry?.artStatus)) errors.push(label)
  }
  status(raw, 'artStatus')
  for (const [form, value] of Object.entries(raw?.forms ?? {})) {
    for (const [state, entry] of Object.entries(value?.states ?? {})) status(entry, `artStatus:state:${form}/${state}`)
  }
  for (const [name, entry] of Object.entries(raw?.transitions ?? {})) status(entry, `artStatus:transition:${name}`)
  for (const [path, entry] of Object.entries(raw?.assets ?? {})) status(entry, `artStatus:asset:${path}`)
  return errors
}
