import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInternalApi, type InternalApiDeps } from './index'
import { LATE_KEYS } from './types'

describe('internal-api provide(重构第二批步 6b:24 个 setX 收成一个)', () => {
  it('fills the late deps the routes read at request time; an undefined key never clears what is there', () => {
    const deps = { stateDir: mkdtempSync(join(tmpdir(), 'iapi-provide-')) } as unknown as InternalApiDeps
    const api = createInternalApi(deps)
    const incidents = { list: () => [] } as unknown as NonNullable<InternalApiDeps['incidents']>
    api.provide({ incidents })
    expect(deps.incidents).toBe(incidents)
    api.provide({ incidents: undefined })
    expect(deps.incidents).toBe(incidents)
  })
  it('only listed keys are copied (a stray field in the patch cannot overwrite core deps like stateDir)', () => {
    const deps = { stateDir: '/real' } as unknown as InternalApiDeps
    const api = createInternalApi(deps)
    api.provide({ stateDir: '/evil' } as never)
    expect(deps.stateDir).toBe('/real')
    expect(LATE_KEYS).not.toContain('stateDir')
  })
})
