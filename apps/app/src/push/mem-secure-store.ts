import { vi } from 'vitest'

/** 内存版 expo-secure-store:按 keychainService 分开存(与真实现一样,service 不同就是两条)。只给测试用。 */
export function memSecureStore() {
  const m = new Map<string, string>()
  const k = (key: string, o?: { keychainService?: string }) => `${o?.keychainService ?? 'app'}/${key}`
  const ss = {
    getItemAsync: vi.fn(async (key: string, o?: { keychainService?: string }) => m.get(k(key, o)) ?? null),
    setItemAsync: vi.fn(async (key: string, v: string, o?: { keychainService?: string }) => { m.set(k(key, o), v) }),
    deleteItemAsync: vi.fn(async (key: string, o?: { keychainService?: string }) => { m.delete(k(key, o)) }),
  }
  return { m, ss }
}
