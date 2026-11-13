/** Synthetic offline evidence only: no daemon, credentials or provider. */
import { readFileSync } from 'node:fs'
import { replayRound4Structurally, type Round4Evidence } from '../src/domain/checkup-structural-replay'

const fixture=process.argv[2]??new URL('../src/test-support/fixtures/checkup-round4-run22.json',import.meta.url)
console.log(JSON.stringify(replayRound4Structurally(JSON.parse(readFileSync(fixture,'utf8')) as Round4Evidence),null,2))
