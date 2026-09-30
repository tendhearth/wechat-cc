import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Backend } from '../backend/types'
import { makeDemoBackend } from '../backend/demo'
import { makeStore, type Store } from './store'

type Ctx = { backend: Backend; store: Store }
const BackendCtx = createContext<Ctx | null>(null)

// v1 只有演示后端;下一份计划在这里切换真后端。
export function BackendProvider({ children, backend }: { children: ReactNode; backend?: Backend }) {
  const value = useMemo<Ctx>(() => {
    const b = backend ?? makeDemoBackend()
    return { backend: b, store: makeStore(b) }
  }, [backend])
  return <BackendCtx.Provider value={value}>{children}</BackendCtx.Provider>
}

export function useBackendCtx(): Ctx {
  const c = useContext(BackendCtx)
  if (!c) throw new Error('BackendProvider missing')
  return c
}
