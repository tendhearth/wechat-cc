// @repo-guard
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { componentAppearance as contract, radius, typeScale } from '../packages/design-tokens/src'
const root = join(__dirname, '..')
const source = (file: string) => readFileSync(join(root, file), 'utf8')
const rule = (file: string, selector: string) => source(`apps/desktop/src/${file}`).split('\n' + selector + ' {')[1]?.split('}')[0] ?? ''
describe('11-08 component appearance contract (ratchet)', () => {
  it('pins owner-approved shapes, roles and platform targets', () => {
    expect(contract.message).toMatchObject({ userRole: 'bubble', replyRole: 'body', userBackground: 'rail', replyBackground: 'transparent', radius: 14, paddingX: 16, paddingY: 12 })
    expect(contract.topic).toMatchObject({ role: 'small', radius: 28, border: 'hair', selectedBorder: 'ink', background: 'transparent', minHeight: { desktop: 36, phone: 44 } })
    expect(contract.textField.chat.radius).toBe(radius.sheet)
    expect(contract.textField.search.radius).toBe(radius.control)
    expect(contract.textField.comment.borderWidth).toBe(0)
    expect(contract.button.minHeight.phone).toBeGreaterThanOrEqual(48)
    expect(contract.iconButton.size.phone).toBeGreaterThanOrEqual(44)
    expect(contract.identity).toMatchObject({ headerTarget: 44, replyAvatar: false, order: 'avatar-name' })
    expect(contract.content).toMatchObject({ borderWidth: 0, referenceBorderWidth: 1, processBorderWidth: 0 })
    for (const role of [contract.topic.role, contract.message.userRole, contract.message.replyRole, contract.matterRow.role]) expect(typeScale[role]).toBeDefined()
  })
  it('CSS consumes the shared contract for buttons, input variants, topics and messages', () => {
    expect(rule('styles.css', '.btn')).toContain('var(--th-button-radius)')
    expect(rule('styles.css', '.btn')).toContain('var(--th-button-role)')
    expect(rule('styles/workbench.css', '.wb-task.now-row')).toContain('var(--th-matter-row-padding-y)')
    expect(rule('cc-now.css', '.now-row')).toContain('var(--th-matter-row-gap)')
    expect(rule('styles/workbench.css', '.wb-btn')).toContain('var(--th-button-radius)')
    expect(rule('styles/converse.css', '.converse-compose')).toContain('var(--th-text-field-chat-radius)')
    expect(rule('styles/converse.css', '.converse-search input')).toContain('var(--th-text-field-search-radius)')
    expect(rule('styles/workbench.css', '.wb-line-compose textarea,.wb-review-send textarea')).toContain('var(--th-text-field-comment-radius)')
    expect(rule('styles/conversation-topics.css', '.conversation-topics button, .conversation-topic-panel button')).toContain('var(--th-topic-radius)')
    expect(rule('styles/converse.css', '.converse-msg-user .converse-bubble')).toContain('var(--th-message-user-background)')
    expect(source('apps/desktop/src/modules/converse.js')).not.toContain('class="converse-avatar"')
  })
  it('RN consumers use the same contract and never duplicate task status dots', () => {
    for (const file of ['Button', 'IconButton', 'TextField', 'TopicRow', 'Card', 'ConversationPresence', 'ConversationScreen', 'MatterRow']) expect(source(`apps/app/src/ui/${file}.tsx`), file).toContain('componentAppearance')
    expect(source('apps/app/src/ui/StatusPill.tsx')).toContain('StatusWord')
    expect(source('apps/app/src/ui/StatusPill.tsx')).not.toMatch(/\bDot\b|Record<StatusKey/)
    expect(source('apps/app/src/ui/TopicRow.tsx')).toContain('accessibilityState={{ selected:')
    for (const [file, variant] of [['ui/ConversationScreen', 'chat'], ['ui/TerminalDetail', 'chat'], ['app/chat-search', 'search'], ['app/topics', 'search'], ['ui/ChangeReview', 'comment']]) expect(source(`apps/app/src/${file}.tsx`), file).toContain(`variant="${variant}"`)
  })
})
