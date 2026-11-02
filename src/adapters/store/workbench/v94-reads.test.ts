import { describe, expect, it } from 'vitest'
import { openSqlite } from '../../../lib/runtime/sqlite'
import { migrations, runMigrations, type Db } from '../../../lib/db'
import { makeWorkbenchStore } from './store'

// v94 搬过来的轮,经 M2b 的读口读出来要和搬家前那两张表读出来的一样(src/lib/db.test.ts 里同一份种子看行本身)。
describe('v94 之后的读口(M2b)', () => {
  const choice = '{"defaults":"provider","model":"opus","reasoningEffort":null}'
  const upgraded = () => {
    const db = openSqlite(':memory:') as unknown as Db
    db.exec('PRAGMA foreign_keys = ON;')
    for (const m of migrations.slice(0, 93)) m(db)
    db.exec('PRAGMA user_version = 93;')
    const matter = db.query("INSERT INTO matters(id,kind,title,state,status,created_at,updated_at) VALUES(?,'task',?,?,'open',1,1)")
    const task = db.query("INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at,matter_id) VALUES(?,?,'/w',?,?,1,?,?)")
    matter.run('0000000a', '做完的', 'done'); task.run('0000000a', '做完的', 'claude', 'completed', 900, '0000000a')
    matter.run('0000000b', '还在跑的', 'working'); task.run('0000000b', '还在跑的', 'cursor', 'running', 950, '0000000b')
    const run = db.query('INSERT INTO workbench_run_execution(run_id,task_id,choice_json,effective_json,created_at,observed_at) VALUES(?,?,?,?,?,?)')
    run.run('run-1', '0000000a', choice, '{"model":"claude-opus-4","source":"native_response"}', 100, 105)
    run.run('run-2', '0000000a', choice, null, 300, null)
    run.run('run-3', '0000000b', '{"defaults":"native","model":null,"reasoningEffort":null}', null, 500, null)
    const usage = db.query('INSERT INTO workbench_turn_usage(task_id,run_id,turn_seq,provider_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd,duration_ms,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    usage.run('0000000a', 'run-1', 1, 'claude', 100, 20, null, null, null, null, 30, 130)
    usage.run('0000000a', 'run-1', 2, 'claude', 50, 5, 300, null, null, null, 10, 200)
    usage.run('0000000a', 'run-2', 1, 'claude', 7, 1, null, null, null, 0.5, null, 320)
    runMigrations(db, migrations)
    return db
  }
  it('读出来和搬家前一样:最后一条 run 的设置、每件事的用量合计', () => {
    const db = upgraded()
    const store = makeWorkbenchStore(db)
    expect(store.execution.last('0000000a')).toEqual({ taskId: '0000000a', runId: 'run-2', choice: JSON.parse(choice), effective: null, createdAt: 300, observedAt: null })
    expect(store.execution.run('0000000a', 'run-1')).toEqual({ taskId: '0000000a', runId: 'run-1', choice: JSON.parse(choice), effective: { model: 'claude-opus-4', source: 'native_response' }, createdAt: 100, observedAt: 105 })
    expect(store.usage.totals('0000000a')).toEqual({ turns: 3, input: 157, output: 26, cacheRead: 300, cacheWrite: null, reasoning: null, costUsd: 0.5 })
    expect(store.usage.sinceByProvider(150)).toEqual([{ providerId: 'claude', turns: 2, input: 57, output: 6 }])
  })
})
