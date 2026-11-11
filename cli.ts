#!/usr/bin/env bun
// Keep the process entry free of the command registry and its module graph.
// Native SessionStart must reach stdin and the local API within the 1s hook limit.
async function main() {
  const argv = process.argv.slice(2)
  const source = argv[1]
  if (argv.length === 2 && argv[0] === 'hook' && (source === 'claude' || source === 'codex')) {
    try {
      const { runHookEntry } = await import('./src/cli/hook-entry')
      await runHookEntry(source)
    } catch { /* hooks must never interfere with the host CLI */ }
    return
  }
  const { main: runCli } = await import('./src/cli/main')
  await runCli(argv)
}

if (import.meta.main) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
