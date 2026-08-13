import { describe, expect, test } from 'vitest'
import type { Msg } from './graph-profiles'
import {
  buildMentionEdges,
  connectors,
  contactProfile,
  detectOwner,
  invertDisplay,
  rankContacts,
  relationshipSubgraph,
  resolveName,
  topContacts,
  type Contact,
  type Edge,
} from './graph'

function mkMsg(over: Partial<Msg>): Msg {
  return {
    is_group: false,
    sender_un: '',
    conversation: '',
    ts: 0,
    ltype: 1,
    content: '',
    kind: 'text',
    ...over,
  }
}

function mkContact(over: Partial<Contact> & { username: string }): Contact {
  return {
    display: over.username,
    is_group: false,
    total: 0,
    sent: 0,
    recv: 0,
    first_ts: 0,
    last_ts: 0,
    known_days: 0,
    active_days: 0,
    initiations: 0,
    transfer_in: 0,
    transfer_out: 0,
    shared_groups: 0,
    types: {},
    s_volume: 0,
    s_recency: 0,
    s_reciprocity: 0,
    s_intimacy: 0,
    closeness: 0,
    ...over,
  }
}

describe('detectOwner', () => {
  test('infers the modal non-conversation-side sender across 1:1 chats', () => {
    const messages: Msg[] = [
      mkMsg({ is_group: false, conversation: 'alice', sender_un: 'me' }),
      mkMsg({ is_group: false, conversation: 'alice', sender_un: 'me' }),
      mkMsg({ is_group: false, conversation: 'alice', sender_un: 'alice' }),
      mkMsg({ is_group: false, conversation: 'bob', sender_un: 'me' }),
      mkMsg({ is_group: false, conversation: 'bob', sender_un: 'bob' }),
      // group messages never vote
      mkMsg({ is_group: true, conversation: 'g1@chatroom', sender_un: 'carol' }),
    ]
    expect(detectOwner(messages)).toBe('me')
  })

  test('override wins outright, even against conflicting votes', () => {
    const messages: Msg[] = [
      mkMsg({ is_group: false, conversation: 'alice', sender_un: 'me' }),
      mkMsg({ is_group: false, conversation: 'alice', sender_un: 'me' }),
      mkMsg({ is_group: false, conversation: 'bob', sender_un: 'me' }),
    ]
    expect(detectOwner(messages, 'someone_else')).toBe('someone_else')
  })

  test('undetectable (no 1:1 votes) -> null', () => {
    const messages: Msg[] = [
      mkMsg({ is_group: true, conversation: 'g1@chatroom', sender_un: 'carol' }),
      // a 1:1 message where sender === conversation never votes either
      mkMsg({ is_group: false, conversation: 'alice', sender_un: 'alice' }),
    ]
    expect(detectOwner(messages)).toBeNull()
    expect(detectOwner([])).toBeNull()
  })
})

describe('resolveName', () => {
  const contacts: Contact[] = [
    mkContact({ username: 'wxid_alice', display: 'Alice' }),
    mkContact({ username: 'wxid_bob1', display: 'Bob' }),
    mkContact({ username: 'wxid_bob2', display: 'Bob' }),
    mkContact({ username: 'wxid_carol', display: 'Caroline' }),
  ]

  test('username-exact match wins outright', () => {
    expect(resolveName(contacts, 'wxid_alice')).toEqual({ username: 'wxid_alice', candidates: [] })
  })

  test('unique display resolves', () => {
    expect(resolveName(contacts, 'Alice')).toEqual({ username: 'wxid_alice', candidates: [] })
  })

  test('colliding display returns candidates, never guesses', () => {
    const result = resolveName(contacts, 'Bob')
    expect(result.username).toBeNull()
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.map(c => c.username).sort()).toEqual(['wxid_bob1', 'wxid_bob2'])
  })

  test('falls through to a unique substring match when there is no display match', () => {
    expect(resolveName(contacts, 'Carol')).toEqual({ username: 'wxid_carol', candidates: [] })
  })

  test('empty/falsy name resolves to nothing, no candidates', () => {
    expect(resolveName(contacts, '')).toEqual({ username: null, candidates: [] })
    expect(resolveName(contacts, null)).toEqual({ username: null, candidates: [] })
  })
})

describe('invertDisplay', () => {
  test('drops any display shared by more than one contact', () => {
    const map = { wxid_alice: 'Alice', wxid_bob1: 'Bob', wxid_bob2: 'Bob' }
    expect(invertDisplay(map)).toEqual({ Alice: 'wxid_alice' })
  })
})

describe('buildMentionEdges', () => {
  test('a group mention resolves to an edge', () => {
    const rows = [{ sender_un: 'a', is_group: true, target_un: 'b' }]
    expect(buildMentionEdges(rows, 'owner')).toEqual([{ a: 'a', b: 'b', kind: 'mention', weight: 1 }])
  })

  test('repeated mentions accumulate weight', () => {
    const rows = [
      { sender_un: 'a', is_group: true, target_un: 'b' },
      { sender_un: 'a', is_group: true, target_un: 'b' },
      { sender_un: 'a', is_group: true, target_un: 'c' },
    ]
    const edges = buildMentionEdges(rows, 'owner')
    expect(edges).toContainEqual({ a: 'a', b: 'b', kind: 'mention', weight: 2 })
    expect(edges).toContainEqual({ a: 'a', b: 'c', kind: 'mention', weight: 1 })
  })

  test('a colliding-display target is dropped, never guessed', () => {
    const displayToUn = invertDisplay({ wxid_bob1: 'Bob', wxid_bob2: 'Bob' }) // {} — collision drops it
    const rows = [{ sender_un: 'a', is_group: true, target_un: 'Bob', viaDisplay: true }]
    expect(buildMentionEdges(rows, 'owner', displayToUn)).toEqual([])
  })

  test('a resolvable display target maps through displayToUn', () => {
    const displayToUn = invertDisplay({ wxid_alice: 'Alice' })
    const rows = [{ sender_un: 'a', is_group: true, target_un: 'Alice', viaDisplay: true }]
    expect(buildMentionEdges(rows, 'owner', displayToUn)).toEqual([
      { a: 'a', b: 'wxid_alice', kind: 'mention', weight: 1 },
    ])
  })

  test('a non-group row is excluded', () => {
    const rows = [{ sender_un: 'a', is_group: false, target_un: 'b' }]
    expect(buildMentionEdges(rows, 'owner')).toEqual([])
  })

  test('owner as sender, owner as target, self-mention, and @chatroom targets are all excluded', () => {
    const rows = [
      { sender_un: 'owner', is_group: true, target_un: 'b' },
      { sender_un: 'a', is_group: true, target_un: 'owner' },
      { sender_un: 'a', is_group: true, target_un: 'a' },
      { sender_un: 'a', is_group: true, target_un: 'g1@chatroom' },
    ]
    expect(buildMentionEdges(rows, 'owner')).toEqual([])
  })
})

describe('topContacts', () => {
  const contacts: Contact[] = [
    mkContact({
      username: 'a',
      closeness: 0.5,
      total: 100,
      last_ts: 1000,
      s_reciprocity: 0.2,
      s_volume: 0.9,
      s_intimacy: 0.9,
      s_recency: 0.9, // neglected: (0.9+0.9)/2 * (1-0.9) = 0.09
    }),
    mkContact({
      username: 'b',
      closeness: 0.9,
      total: 10,
      last_ts: 3000,
      s_reciprocity: 0.9,
      s_volume: 0.05,
      s_intimacy: 0.05,
      s_recency: 0.05, // neglected: (0.05+0.05)/2 * (1-0.05) = 0.0475
    }),
    mkContact({
      username: 'c',
      closeness: 0.2,
      total: 50,
      last_ts: 2000,
      s_reciprocity: 0.5,
      s_volume: 0.9,
      s_intimacy: 0.9,
      s_recency: 0.1, // neglected: (0.9+0.9)/2 * (1-0.1) = 0.81 (highest)
    }),
    // filtered out of 'person' results
    mkContact({ username: 'grp', is_group: true, closeness: 1.0 }),
  ]

  test('closeness (default)', () => {
    expect(topContacts(contacts, 'closeness').map(c => c.username)).toEqual(['b', 'a', 'c'])
  })

  test('volume -> total desc', () => {
    expect(topContacts(contacts, 'volume').map(c => c.username)).toEqual(['a', 'c', 'b'])
  })

  test('recency -> last_ts desc', () => {
    expect(topContacts(contacts, 'recency').map(c => c.username)).toEqual(['b', 'c', 'a'])
  })

  test('reciprocity -> s_reciprocity desc', () => {
    expect(topContacts(contacts, 'reciprocity').map(c => c.username)).toEqual(['b', 'c', 'a'])
  })

  test('neglected -> (s_volume+s_intimacy)/2 * (1-s_recency) desc', () => {
    expect(topContacts(contacts, 'neglected').map(c => c.username)).toEqual(['c', 'a', 'b'])
  })

  test('unrecognized sort key falls back to closeness', () => {
    expect(topContacts(contacts, 'bogus').map(c => c.username)).toEqual(['b', 'a', 'c'])
  })

  test("kind: 'group' filters to is_group contacts only", () => {
    expect(topContacts(contacts, 'closeness', 20, 'group').map(c => c.username)).toEqual(['grp'])
  })

  test('limit truncates', () => {
    expect(topContacts(contacts, 'closeness', 1).map(c => c.username)).toEqual(['b'])
  })
})

describe('contactProfile', () => {
  const contacts: Contact[] = [mkContact({ username: 'wxid_alice', display: 'Alice' })]
  const edges: Edge[] = [{ a: 'wxid_alice', b: 'wxid_bob', kind: 'mention', weight: 2 }]
  const edgesFor = (username: string, kind: string) =>
    edges.filter(e => e.kind === kind && (e.a === username || e.b === username))

  test('resolved contact includes mention_partners', () => {
    const result = contactProfile(contacts, edgesFor, 'Alice')
    expect(result.resolved).toBe(true)
    if (result.resolved) {
      expect(result.username).toBe('wxid_alice')
      expect(result.mention_partners).toEqual(edges)
    }
  })

  test('unresolved name returns candidates', () => {
    const result = contactProfile(contacts, edgesFor, 'nobody')
    expect(result).toEqual({ resolved: false, candidates: [] })
  })
})

describe('rankContacts', () => {
  test('closeness-sorted username+display+closeness, limited', () => {
    const contacts: Contact[] = [
      mkContact({ username: 'a', display: 'A', closeness: 0.3 }),
      mkContact({ username: 'b', display: 'B', closeness: 0.9 }),
      mkContact({ username: 'c', display: 'C', closeness: 0.6 }),
    ]
    expect(rankContacts(contacts, undefined, 2)).toEqual([
      { username: 'b', display: 'B', closeness: 0.9 },
      { username: 'c', display: 'C', closeness: 0.6 },
    ])
  })
})

describe('relationshipSubgraph', () => {
  test('nodes are closeness-ranked; mention edges kept only within the kept set; me-edges synthesized', () => {
    const contacts: Contact[] = [
      mkContact({ username: 'a', display: 'A', closeness: 0.9 }),
      mkContact({ username: 'b', display: 'B', closeness: 0.5 }),
      mkContact({ username: 'outside', display: 'O', closeness: 0.1 }),
    ]
    const allEdges: Edge[] = [
      { a: 'a', b: 'b', kind: 'mention', weight: 3 },
      { a: 'a', b: 'outside', kind: 'mention', weight: 5 }, // outside not in top-2 -> dropped
    ]
    const edgesFor = (username: string, kind: string) =>
      allEdges.filter(e => e.kind === kind && (e.a === username || e.b === username))

    const sub = relationshipSubgraph(contacts, edgesFor, 'owner', undefined, 2)
    expect(sub.owner).toBe('owner')
    expect(sub.nodes.map(n => n.username)).toEqual(['a', 'b'])
    expect(sub.edges).toContainEqual({ a: 'owner', b: 'a', kind: 'me', weight: 0.9 })
    expect(sub.edges).toContainEqual({ a: 'owner', b: 'b', kind: 'me', weight: 0.5 })
    expect(sub.edges).toContainEqual({ a: 'a', b: 'b', kind: 'mention', weight: 3 })
    expect(sub.edges.some(e => e.b === 'outside' || e.a === 'outside')).toBe(false)
  })
})

describe('connectors', () => {
  const contacts: Contact[] = [
    mkContact({ username: 'wxid_alice', display: 'Alice', shared_groups: 2 }),
    mkContact({ username: 'wxid_bob', display: 'Bob', shared_groups: 4 }),
  ]
  const allEdges: Edge[] = [
    { a: 'wxid_alice', b: 'wxid_bob', kind: 'mention', weight: 1 },
    { a: 'wxid_bob', b: 'wxid_alice', kind: 'mention', weight: 2 },
    { a: 'wxid_alice', b: 'wxid_carol', kind: 'mention', weight: 9 }, // unrelated to bob -> excluded
  ]
  const edgesFor = (username: string, kind: string) =>
    allEdges.filter(e => e.kind === kind && (e.a === username || e.b === username))

  test('shared group + mutual mention between two resolved contacts', () => {
    const sharedGroupsOf = (a: string, b: string) => {
      expect([a, b].sort()).toEqual(['wxid_alice', 'wxid_bob'].sort())
      return 3
    }
    const result = connectors(contacts, edgesFor, sharedGroupsOf, 'Alice', 'Bob')
    expect(result.resolved).toBe(true)
    expect(result.a).toBe('wxid_alice')
    expect(result.b).toBe('wxid_bob')
    expect(result.shared_groups_a).toBe(2)
    expect(result.shared_groups_b).toBe(4)
    expect(result.shared_groups).toBe(3)
    expect(result.mention_edges).toEqual([
      { a: 'wxid_alice', b: 'wxid_bob', kind: 'mention', weight: 1 },
      { a: 'wxid_bob', b: 'wxid_alice', kind: 'mention', weight: 2 },
    ])
  })

  test('unresolved name -> resolved: false', () => {
    const result = connectors(contacts, edgesFor, () => 0, 'nobody', 'Bob')
    expect(result).toEqual({ resolved: false })
  })
})
