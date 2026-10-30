// @ts-check
// Native navigate events and pending navigation are untrusted input.
/** @param {unknown} page @returns {'overview' | 'a2a-agents' | null} */
export const mainDestination = page => page === 'overview' || page === 'a2a-agents' ? page : null
