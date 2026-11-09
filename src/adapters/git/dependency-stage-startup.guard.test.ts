import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
it('runs dependency stage recovery on daemon startup with independent error reporting',()=>{
  const source=readFileSync(new URL('../../daemon/startup-sweeps.ts',import.meta.url),'utf8')
  expect(source).toMatch(/recoverDependencyStages\(deps\.stateDir\)\.catch/)
})
it('keeps dependency installation free of package managers, SSH, and user configuration discovery',()=>{
  for(const name of ['worktree-dependency-installer.ts','worktree-dependency-archive.ts','worktree-dependency-policy.ts']){
    const source=readFileSync(new URL(name,import.meta.url),'utf8')
    expect(source).not.toMatch(/from ['"](?:node:child_process|child_process|bun|execa)['"]|process\.env\.(?:HOME|USERPROFILE|XDG_CONFIG_HOME|SSH_AUTH_SOCK)|homedir\(/)
  }
})
