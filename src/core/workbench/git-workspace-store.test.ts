import {expect,it} from 'vitest'
import {openSqlite} from '../../lib/runtime/sqlite'
import {createGitWorkspaceStore,GIT_WORKSPACE_SCHEMA_SQL} from './git-workspace-store'
import type {GitWorkspaceRecord} from './git-workspaces'

it('refuses a reservation overwrite with the same UUID but a different frozen owner',()=>{
  const db=openSqlite(':memory:');db.exec(GIT_WORKSPACE_SCHEMA_SQL);const store=createGitWorkspaceStore(db)
  // Store exercises only its immutable identity boundary; filesystem validation
  // belongs to the manager's real-Git fixtures, not a mocked Git implementation.
  const record:GitWorkspaceRecord={
    id:'123e4567-e89b-42d3-a456-426614174000',workspaceId:'123e4567-e89b-42d3-a456-426614174000',ownerKey:'owner',requestId:'request',canonicalRequestHash:'a'.repeat(64),providerId:'fixture',
    sourcePath:'/fixture/source',sourceIdentity:'1:2',gitRoot:'/fixture/source',gitRootIdentity:'1:2',gitDir:'/fixture/source/.git',gitDirIdentity:'1:3',commonDir:'/fixture/source/.git',commonDirIdentity:'1:3',projectSubpath:'',baseCommit:'b'.repeat(40),sourceBranch:'refs/heads/main',branch:'codex/cc-task-123e4567-e89b-42d3-a456-426614174000',worktreeRoot:'/fixture/workspace',executionPath:'/fixture/workspace',directoryIdentity:null,executionIdentity:null,worktreeGitDir:null,worktreeGitDirIdentity:null,rootIdentity:null,sourceGitState:{head:'b'.repeat(40),index:{}},sourceStatus:'',configurationFingerprint:null,status:'reserved',failureReason:null,createdAt:1,updatedAt:1,
  }
  try{store.reserve(record);expect(()=>store.reserve({...record,ownerKey:'another'})).toThrow('git_workspace_conflict');expect(store.get(record.id)?.ownerKey).toBe('owner')}finally{db.close()}
})
