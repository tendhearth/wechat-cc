import { createState } from '../cc-companion-entry/state.js'

export function makePreview() {
  const state = createState()
  /** @type {Record<string,string>} */
  const phases = { login: 'running', website: 'decision', talk: 'complete' }
  /** @type {Record<string,string>} */
  const choices = {}
  function check(id) { if (!Object.hasOwn(phases,id)) throw new Error('Unknown work item') }
  return Object.assign(state, {
    choices,
    phase(id) { check(id); return phases[id] },
    setPhase(id, phase) {
      check(id)
      if (!['running','decision','complete'].includes(phase)) throw new Error('Unknown phase')
      phases[id] = phase
    },
    decide(id, choice) {
      check(id)
      if (phases[id] !== 'decision') throw new Error('No decision pending')
      choices[id] = choice; phases[id] = 'running'
    },
  })
}
