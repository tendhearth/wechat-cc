import {defineConfig,mergeConfig} from 'vitest/config'
import base from './vitest.config'
/** Node targeted verification for process supervision (also run by Bun verify). */
export default mergeConfig(base,defineConfig({test:{include:['scripts/verify*.test.ts']}}))
