/**
 * fake-media.ts — vi.mock for ../media so e2e tests don't hit the real
 * ilink CDN. The mock replaces materializeAttachments with a stub that
 * writes a tiny placeholder file under <inboxDir>/<userId>/ and rewrites
 * the attachment's path so downstream formatInbound can emit the
 * [image:/abs/path] marker that speakers Read/Bash to inspect content.
 *
 * Side-effect import: `import './fake-media'` from the harness BEFORE
 * the daemon's main is dynamically imported. vi.mock is hoisted within
 * THIS file, so the mock activates when this module is first evaluated.
 *
 * Tests that need to know what got materialized can read
 * `getMaterializedFiles()` after the dispatch completes.
 */
import { vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface MaterializedRecord {
  kind: string
  path: string
  userId: string
}

const materialized: MaterializedRecord[] = []

export function getMaterializedFiles(): readonly MaterializedRecord[] {
  return [...materialized]
}

export function resetMaterialized(): void {
  materialized.length = 0
}

vi.mock('../media', async () => {
  // Pull through the original module so we don't accidentally erase any
  // helper exports (sweepInbox, sendFileViaCdn, etc.). Tests only override
  // materializeAttachments — outbound paths still use the real impl, but
  // that's fine because no e2e test currently exercises outbound media.
  const actual = await vi.importActual<typeof import('../media')>('../media')
  return {
    ...actual,
    materializeAttachments: async (
      msg: { userId: string; attachments?: Array<{ kind: string; path: string; caption?: string }>; createTimeMs?: number },
      inboxDir: string,
      log: (tag: string, line: string) => void,
    ) => {
      if (!msg.attachments) return
      for (const a of msg.attachments) {
        if (a.path !== '<pending-cdn-ref>') continue
        const userDir = join(inboxDir, msg.userId)
        if (!existsSync(userDir)) mkdirSync(userDir, { recursive: true })
        const ext = a.kind === 'image' ? 'jpg' : a.kind === 'voice' ? 'amr' : 'bin'
        const filename = `e2e-${msg.createTimeMs ?? Date.now()}-${a.kind}.${ext}`
        const filepath = join(userDir, filename)
        // 3-byte JPEG-magic stub so anyone running `file` on the artifact
        // sees something reasonable. Test bodies don't read content, just
        // check the path marker, so 3 bytes is enough.
        writeFileSync(filepath, Buffer.from([0xff, 0xd8, 0xff]))
        a.path = filepath
        a.caption = undefined
        materialized.push({ kind: a.kind, path: filepath, userId: msg.userId })
        log('MEDIA', `[fake] materialized ${a.kind} → ${filepath}`)
      }
    },
  }
})
