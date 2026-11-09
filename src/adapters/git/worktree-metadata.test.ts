import { expect, it } from 'vitest'
import { samePreparationMetadata } from './worktree-dependencies'

it.each(['package.json','pkg/package.json','bun.lock','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','.npmrc','bunfig.toml'])('accepts only checkout CRLF/LF differences in text metadata: %s', path => {
  const lf = Buffer.from('first\nsecond\n'), crlf = Buffer.from('first\r\nsecond\r\n')
  expect(samePreparationMetadata(path, lf, crlf)).toBe(true)
  expect(samePreparationMetadata(path, crlf, lf)).toBe(true)
  expect(samePreparationMetadata(path, lf, Buffer.from('first\nchanged\n'))).toBe(false)
})
it('preserves binary, invalid UTF-8, bare CR, escaped JSON strings and final-newline differences', () => {
  expect(samePreparationMetadata('bun.lockb', Buffer.from('a\r\nb'), Buffer.from('a\nb'))).toBe(false)
  expect(samePreparationMetadata('unknown', Buffer.from('a\r\nb'), Buffer.from('a\nb'))).toBe(false)
  expect(samePreparationMetadata('bun.lock', Buffer.from([0xff,10]), Buffer.from([0xfe,10]))).toBe(false)
  expect(samePreparationMetadata('bun.lock', Buffer.from('a\rb'), Buffer.from('a\nb'))).toBe(false)
  expect(samePreparationMetadata('package.json', Buffer.from('{"script":"a\\r\\nb"}'), Buffer.from('{"script":"a\\nb"}'))).toBe(false)
  expect(samePreparationMetadata('bun.lock', Buffer.from('a\n'), Buffer.from('a'))).toBe(false)
})
