import { isDeepStrictEqual } from 'node:util'
import { WORKBENCH_PERMISSION_DESCRIPTION_MAX } from '../workbench/permissions'

/** Field displays flatten JSON types into strings. Supply typed evidence
 * when arguments include any other value, and detect serialization losses. */
export function toolArgumentEvidence(input: Record<string, unknown>): { argumentJson?: string; incomplete?: true } {
  try {
    const json = JSON.stringify(input)
    if (json.length > WORKBENCH_PERMISSION_DESCRIPTION_MAX || !isDeepStrictEqual(JSON.parse(json), input)) return { incomplete: true }
    return Object.values(input).some(value => typeof value !== 'string') ? { argumentJson: json } : {}
  } catch {
    return { incomplete: true }
  }
}
