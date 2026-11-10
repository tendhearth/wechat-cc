import type { Reporter, TestModule } from 'vitest/node'

/** Queued means a worker picked up the file, before imports/collection. */
export default class VerifyReporter implements Reporter {
  private emit(event: 'start' | 'end' | 'finished', module?: TestModule) {
    const token = process.env.CC_VERIFY_PROGRESS_TOKEN
    if (token) process.stdout.write(`\n\x1eCC_VERIFY:${token}:${JSON.stringify({event, id:module?.id, file:module?.moduleId, project:module?.project.name})}\n`)
  }
  onTestModuleQueued(module: TestModule) { this.emit('start', module) }
  onTestModuleEnd(module: TestModule) { this.emit('end', module) }
  onTestRunEnd() { this.emit('finished') }
}
