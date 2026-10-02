import { getRandomValues } from 'expo-crypto'
import { installPolyfills, type PolyfillTarget } from './polyfills'

const done = installPolyfills(globalThis as unknown as PolyfillTarget, a => getRandomValues(a))
if (__DEV__ && done.length) console.log(`[tendhearth] polyfilled: ${done.join(', ')}`)
