import { DurableObject } from 'cloudflare:workers'

export class Room extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response('not implemented', { status: 501 })
  }
}
