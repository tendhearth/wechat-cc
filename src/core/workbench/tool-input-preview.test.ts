import { expect, it } from 'vitest'
import { toolInputPreview } from './tool-input-preview'

it('keeps arguments reviewable without recording recognizable credentials', () => {
  const input = {
    action: 'fetch', count: 3,
    token: 'token-fixture',
    url: 'https://person:password-fixture@example.test/report?q=notes&api_key=query-fixture',
    headers: [{ name: 'Authorization', value: 'Bearer header-fixture' }, { name: 'Accept', value: 'application/json' }],
    nested: { Cookie: 'cookie-fixture', message: 'See https://example.test/?access_token=embedded-fixture for status.' },
  }
  const before = JSON.stringify(input), preview = toolInputPreview(input)!
  for (const value of ['token-fixture', 'person', 'password-fixture', 'query-fixture', 'header-fixture', 'cookie-fixture', 'embedded-fixture']) expect(preview).not.toContain(value)
  expect(preview).toContain('example.test/report?q=notes')
  expect(preview).toContain('application/json')
  expect(preview).toContain('"count":3')
  expect(JSON.stringify(input)).toBe(before)
})

it('handles nested key/value header pairs, bearer strings and URL signatures', () => {
  const preview = toolInputPreview({ rows: [{ key: 'X-Api-Key', value: 'pair-fixture' }], text: 'Authorization: Bearer bearer-fixture',
    url: 'https://example.test/file?X-Amz-Signature=signed-fixture&X-Amz-Credential=credential-fixture&name=report' })!
  for (const value of ['pair-fixture', 'bearer-fixture', 'signed-fixture', 'credential-fixture']) expect(preview).not.toContain(value)
  expect(preview).toContain('name=report')
})

it('fails closed on cyclic or oversized input rather than show a partial approval', () => {
  const circular: Record<string, unknown> = {}; circular.self = circular
  expect(toolInputPreview(circular)).toBeNull()
  expect(toolInputPreview({ text: 'a'.repeat(20_001) })).toBeNull()
  expect(toolInputPreview(undefined)).toBeNull()
  expect(toolInputPreview({ count: 0 })).toBe('{"count":0}')
})
