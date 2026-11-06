import { expect, it } from 'vitest'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { originOf, SPEECH_KINDS } from '../src/domain/speech/kinds'
import { SPEECH_SOURCES } from '../src/daemon/speech/proposal'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sources = {
  agenda: ['src/features/companion/tick-push.ts', 'src/features/companion/tick-dispatch.ts'],
  gap: ['src/features/companion/gap-action.ts'], hunt: ['src/features/hunt/action.ts'],
  visit: ['src/daemon/wiring/companion-actions.ts'], guest: ['src/features/companion/tick-push.ts'],
  letter: ['src/features/letters/runtime.ts'], brief: ['src/features/companion/tick-job.ts'], recap: ['src/features/companion/tick-job.ts'],
  memory: ['src/features/memory/nightly-runtime.ts'], sticker: ['src/features/stickers/artist-step.ts'],
  social: ['src/features/social/social-tell.ts', 'src/features/social/wire-social.ts', 'src/features/social/postcard-proposal.ts'],
} satisfies Record<keyof typeof SPEECH_SOURCES, string[]>
const sends = new Set(['sendText', 'sendFile', 'sendMessage', 'sendAssistantText', 'sendSticker', 'sendAttachment', 'sendOnce', 'sendReplyOnce', 'fanoutPush'])
/** Entry points may submit data and producer adapters. Only a callback given an
 * authorized turn may deliver. Requested writeNow is a synchronous user reply.
 * A named adapter must require ProactiveTurn; optional authorization is rejected.
 */
export function directSends(text: string): string[] {
  const file = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true)
  const bad: string[] = []
  function visit(node: ts.Node, authorized = false, requested = false) {
    if (ts.isFunctionLike(node)) {
      authorized = authorized || node.parameters.some(p => !p.questionToken && p.type?.getText(file).includes('ProactiveTurn'))
      const parent = node.parent
      if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && ['propose', 'say'].includes(parent.expression.name.text) && parent.arguments[1] === node) authorized = true
      if (ts.isPropertyAssignment(parent) && parent.name.getText(file) === 'writeNow') requested = true
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : ''
      if (name === 'say') {
        const arg = node.arguments[0]
        const kind = arg && ts.isObjectLiteralExpression(arg) ? arg.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === 'kind') : null
        const value = kind && ts.isPropertyAssignment(kind) && ts.isStringLiteral(kind.initializer) ? kind.initializer.text : null
        if (!value || !(value in SPEECH_KINDS) || originOf(value as keyof typeof SPEECH_KINDS) === 'initiative') bad.push('raw initiative say')
      }
      if ((sends.has(name) || (name === 'begin' && node.expression.getText(file).includes('replyDelivery'))) && !authorized && !requested) bad.push(node.expression.getText(file))
    }
    ts.forEachChild(node, child => visit(child, authorized, requested))
  }
  visit(file)
  return bad
}
it('covers every registered initiative source', () => {
  expect(Object.keys(sources).sort()).toEqual(Object.keys(SPEECH_SOURCES).sort())
})
it('detects direct sends and raw initiative say, including inside nested callbacks', () => {
  expect(directSends("async function tick() { await ilink.sendMessage('owner', 'x'); queueMicrotask(() => d.sendText('owner', 'x')) }" )).toHaveLength(2)
  expect(directSends("speech.say({ kind: 'letter' }, async turn => turn.sendText('owner', 'x'))")).toEqual(['raw initiative say'])
  expect(directSends("speech.propose({source: 'letter'}, async turn => turn.sendText('owner', 'x'))")).toEqual([])
  expect(directSends("async function deliver(outbound?: ProactiveTurn) { await d.sendFile('owner', 'x') }")).toHaveLength(1)
})
it('initiators can only deliver inside an authorized producer adapter', () => {
  const violations = [...new Set(Object.values(sources).flat())].flatMap(path => directSends(readFileSync(join(root, path), 'utf8')).map(call => `${path}: ${call}`))
  expect(violations).toEqual([])
})

it('retired private send time cannot return to the production budget or source cadence', () => {
  for (const path of [...new Set([...Object.values(sources).flat(), 'src/features/companion/care-ledger.ts', 'src/features/companion/calibration.ts', 'src/domain/companion-plan.ts', 'src/features/companion/tick-push.ts', 'src/daemon/foundation.ts'])]) {
    expect(readFileSync(join(root, path), 'utf8'), path).not.toContain('lastProactiveAtIso')
  }
})
