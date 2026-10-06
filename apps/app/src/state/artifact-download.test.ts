import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { BackendError } from '../backend/types'
import { ARTIFACT_MAX_BYTES, downloadArtifact, downloadReplyFile, humanSize, previewKind } from './artifact-download'
import { bytesToBase64 } from './image-upload'

const sha = async (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const bytes = new Uint8Array(300_000).map((_, i) => (i * 7) % 256)
const ref = { id: 'a1', name: 'report.pdf', mime: 'application/pdf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
const computer = (corrupt = false) => ({
  artifactChunk: vi.fn(async ({ offset }: { offset: number }) => {
    const end = Math.min(bytes.length, offset + 128 * 1024)
    const piece = bytes.slice(offset, end); if (corrupt && offset > 0) piece[0] = piece[0]! ^ 1
    return { offset, nextOffset: end, size: bytes.length, contentBase64: bytesToBase64(piece) }
  }),
})

describe('downloadArtifact', () => {
  it('reads 128 KiB chunks and returns the exact verified bytes', async () => {
    const c = computer()
    expect(await downloadArtifact(c, 'deadbeef', ref, sha)).toEqual(bytes)
    expect(c.artifactChunk.mock.calls.map(x => x[0].offset)).toEqual([0, 131072, 262144])
  })
  it('a file that changed mid-way is stale, not silently wrong', async () => {
    await expect(downloadArtifact(computer(true), 'deadbeef', ref, sha)).rejects.toMatchObject({ code: 'stale' })
  })
  it('refuses very large outputs before reading anything', async () => {
    const c = computer()
    await expect(downloadArtifact(c, 'deadbeef', { ...ref, size: ARTIFACT_MAX_BYTES + 1 }, sha)).rejects.toBeInstanceOf(BackendError)
    expect(c.artifactChunk).not.toHaveBeenCalled()
  })
})

describe('previewKind / humanSize', () => {
  it('images and text in-app; everything else through the system', () => {
    expect(previewKind('image/png', 'a.png')).toBe('image')
    expect(previewKind('text/markdown', 'a.md')).toBe('text')
    expect(previewKind('application/octet-stream', 'notes.md')).toBe('text')
    expect(previewKind('application/pdf', 'a.pdf')).toBe('file')
    expect(previewKind('text/html', 'site.html')).toBe('file')
  })
  it('reads naturally', () => { expect(humanSize(900)).toBe('900 B'); expect(humanSize(300_000)).toBe('293 KB'); expect(humanSize(5_000_000)).toBe('4.8 MB') })
})

describe('downloadReplyFile (2026-10-06)', () => {
  const file = new Uint8Array(200_000).map((_, i) => (i * 13) % 256)
  const fileSha = createHash('sha256').update(file).digest('hex')
  const chunker = (mutate?: (off: number) => Partial<{ size: number; sha256: string }>) => ({
    chatFileChunk: vi.fn(async ({ offset }: { offset: number }) => {
      const end = Math.min(file.length, offset + 128 * 1024)
      return { name: 'r.pdf', mime: 'application/pdf', size: file.length, sha256: fileSha, offset, nextOffset: end, contentBase64: bytesToBase64(file.slice(offset, end)), ...(mutate?.(offset) ?? {}) }
    }),
  })
  it('learns size and hash from the first chunk and returns the exact bytes', async () => {
    const c = chunker()
    expect(await downloadReplyFile(c, 'm1', 1, sha)).toEqual(file)
    expect(c.chatFileChunk.mock.calls.map(x => x[0])).toEqual([{ messageId: 'm1', index: 1, offset: 0 }, { messageId: 'm1', index: 1, offset: 131072 }])
  })
  it('a file replaced mid-download is stale', async () => {
    await expect(downloadReplyFile(chunker(off => off > 0 ? { sha256: 'b'.repeat(64) } : {}), 'm1', 1, sha)).rejects.toMatchObject({ code: 'stale' })
  })
  it('too large is refused after the first chunk', async () => {
    await expect(downloadReplyFile(chunker(() => ({ size: ARTIFACT_MAX_BYTES + 1 })), 'm1', 1, sha)).rejects.toMatchObject({ code: 'too_large' })
  })
})
