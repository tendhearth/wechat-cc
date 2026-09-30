declare namespace Cloudflare {
  // 让 cloudflare:test / cloudflare:workers 的 env 带上 wrangler 绑定(ROOM 等)。
  interface Env extends globalThis.Env {}
}
