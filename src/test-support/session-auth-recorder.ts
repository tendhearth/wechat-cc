/** Observe real test-daemon mints at their source; never put credentials back in SDK options. */
import { vi } from 'vitest'
import type { UserTier } from '../domain/user-tier'

export interface RecordedSessionAuth { token: string; tier: UserTier; sessionKey: string }

export async function installSessionAuthRecorder(record: (auth: RecordedSessionAuth) => void): Promise<{ uninstall(): void }> {
  const module = await import('../daemon/internal-api/token-registry')
  const make = module.makeTokenRegistry
  const observer = vi.spyOn(module, 'makeTokenRegistry').mockImplementation((...args) => {
    const registry = make(...args)
    const mint = registry.mint.bind(registry)
    registry.mint = (tier, sessionKey, options) => {
      const token = mint(tier, sessionKey, options)
      record({ token, tier, sessionKey })
      return token
    }
    return registry
  })
  return { uninstall: () => observer.mockRestore() }
}
