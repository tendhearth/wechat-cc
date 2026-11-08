import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'

export const owner = 'secondary_completion'
export const stamp = '2026-10-28T12:00:00Z'
export const longText = '在窗边做一点慢慢完成的事。\n保留完整的内容，也保留后来继续的余地。\nLong titles and paragraphs stay readable without losing the source.'
const image = 'data:image/png;base64,' + readFileSync('src/assets/pet/cc-v1/canonical/lit/front.png').toString('base64')
export const work = { id: 'secondary-work', createdAt: stamp, caption: '窗边的光 / Light by the window', image_data: image, width: 512, height: 512, rendererId: 'fixture', impulse: { medium: '水彩' }, background: { title: '窗边的光 / Light by the window', origin: longText, approach: longText, kind: 'test' }, shareState: 'private' }
export const postcard = { id: 'secondary-postcard', ts: stamp, title: '去朋友家坐了一会儿', note: longText, favorite: 0, image_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect width="300" height="200" fill="#e4ddd2"/><circle cx="150" cy="95" r="50" fill="#4f6b4f"/></svg>' }
export const fact = { id: 101, contact: 'friend', kind: 'obligation', predicate: '约定', value: '把窗边植物的照片发给阿柚，再和她聊聊周末的安排。', time_ref: '2099-10-29', confidence: 'high', updated_at: Math.floor(Date.now() / 1000) }
export const source = { kind: 'memory', path: 'memory.md', label: '长期记忆原文' }
const profile = { version: 1, generatedAt: stamp, chatId: owner, needsRefresh: false, insight: '愿意把重要的事慢慢做好。', summary: longText, tags: ['自然', '手作'], traits: [{ title: '留意细节', body: longText, sources: ['memory.md'], sourceRefs: [source] }], preferences: [{ title: '先看完整内容', body: longText, sources: ['memory.md'], sourceRefs: [source] }], rememberedEvents: [{ title: '窗台上的植物', body: longText, sources: ['memory.md'], sourceRefs: [source] }] }
export type FixtureMode = 'normal' | 'empty' | 'error'

/** Payload shapes match the real desktop module routes; never count missing-route
 * errors as normal evidence. Individual tests can override one boundary for loading. */
export async function secondaryFixtures(page: Page, mode: FixtureMode = 'normal') {
  const empty = mode === 'empty'
  const routes: Record<string, unknown> = {
    '/v1/journal/postcards': { items: empty ? [] : [postcard], total: empty ? 0 : 1 },
    '/v1/atelier/works': { works: empty ? [] : [work] },
    '/v1/atelier/model-status': { mode: 'private', status: { state: 'ready' } },
    '/v1/companion/thoughts': { items: empty ? [] : [{ id: 'thought', ts: stamp, title: '把这一天收好', note: longText }] },
    '/v1/journal': { items: empty ? [] : [{ id: 'catch', kind: 'hunt', ts: stamp, title: '周末可以做的一件小作品', note: longText, url: 'https://example.com/project', status: 'new' }, { id: 'visit', kind: 'visit', ts: stamp, title: '在朋友家听到的故事', note: longText, status: 'new' }] },
    '/v1/social/relationships': { relationships: empty ? [] : [{ id: 'neighbor:ayou', kind: 'neighbor', label: '阿柚', channel: null, familiarity: { visits: 2, lastAt: stamp, note: longText }, origin: '公共伙伴', autoVisit: true }] },
    '/v1/social/wishes': { wishes: empty ? [] : [{ id: 'wish', text: '周末一起做个小作品', status: 'draft', created_at: stamp, expires_at: null, sent_to: 0, replies: 0 }] },
    '/v1/social/intro/offers': { offers: [] },
    '/v1/a2a/list': { agents: empty ? [] : [{ id: 'ayou', name: '阿柚的 CC', transport: 'mailbox', relays: [], paused: false }] },
    '/v1/a2a/info': { enabled: true }, '/v1/social/inbound': { enabled: true },
    '/v1/penpal/channels': { channels: empty ? [] : [{ id: 'mail', peer_label: '阿柚', title: '窗台上的花', last_preview: longText, unread: 1 }] },
    '/v1/penpal/letters': { letters: [{ id: 'letter', direction: 'in', plaintext: longText, created_at: stamp }] },
    '/v1/penpal/letters/read': { ok: true },
    '/v1/knowledge/graph/top_contacts': { contacts: [{ username: 'friend', display: '阿柚' }] },
    '/v1/access/list': { ok: true, admins: [owner] },
    '/v1/memory/files': empty ? [] : [{ userId: owner, fileCount: 2, files: [{ path: 'memory.md', size: 190, mtime: stamp }, { path: 'notes/raw.md', size: 190, mtime: stamp }] }],
    '/v1/memory/file': { ok: true, content: '# 长期记忆\n\n' + longText, path: 'memory.md' },
    '/v1/memory/profile': empty ? { ok: false, error: 'not_found' } : { ok: true, content: JSON.stringify(profile) },
    '/v1/memory/profile/status': { ok: true, status: 'ready', canGenerate: true, reason: 'ok' },
    '/v1/memory/portrait': { ok: true, url: null },
    '/v1/memory/projects': { projects: empty ? [] : [{ name: '窗边小项目', project: '-fixture', files: [{ path: 'MEMORY.md', content: '# 项目记录\n\n' + longText }] }] },
    '/v1/memory/retractions': { items: empty ? [] : [{ key: 'old', text: '喜欢美式咖啡', section: '偏好', day: '2026-10-28' }] },
    '/v1/memory/source': { ok: true, content: longText, revision: 'revision-1', editable: true, canMarkOutdated: false, needsRefresh: false },
    '/v1/memory/view': { ok: true, chatId: owner, path: 'memory.md', baseHash: 'a'.repeat(64), generatedAt: stamp, stale: false, lines: [{ text: '我喜欢在窗边看书', origin: 'owner', assertionId: 'owner-1', replaces: { text: '喜欢美式咖啡' } }, { text: '周末做手工', origin: 'generated', lineKey: 'm:2' }] },
    '/v1/observations/list': { observations: empty ? [] : [{ id: 'obs', ts: stamp, body: '你最近常常说起窗台上的植物。', tone: 'quiet' }] },
    '/v1/milestones/list': { milestones: [] }, '/v1/events/list': { events: [] },
    '/v1/plugins/list': { plugins: empty ? [] : [{ name: 'garden-notes', display_name: '花园笔记 / Garden notes', version: '1.0.0', description: longText, enabled: true, ready: true, source: 'user', tools: ['garden_read', 'garden_save'], has_sync: false }, { name: 'archive', display_name: '本机归档', version: '1.0.0', description: '读取你主动交来的本机资料。', enabled: true, ready: false, not_ready_reason: '尚未完成认证', source: 'user', tools: [], has_setup: true }] },
    '/v1/plugins/registry': { plugins: empty ? [] : [{ name: 'weather', display_name: '天气', version: '1.0.0', description: '查看天气预报。', author: 'Nate Gu & Co.', installed: false }] },
  }
  await page.route(url => Object.hasOwn(routes, url.pathname), route => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({ status: mode === 'error' ? 503 : 200, json: mode === 'error' ? { error: 'temporary_unavailable' } : routes[path] })
  })
  await page.route('**/v1/knowledge/facts/find_facts', route => route.fulfill({ status: mode === 'error' ? 503 : 200, json: mode === 'error' ? { error: 'temporary_unavailable' } : { results: empty ? [] : route.request().postDataJSON().status === 'active' ? [fact] : [{ ...fact, id: 102, value: '已经把借来的书还给朋友。' }] } }))
}
