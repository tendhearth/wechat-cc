# CC workbench — existing sessions and recorded handoff

Owner-approved follow-on to daily-use tasks1–4. Current worktree codex/cc-workbench-v1, no push/merge. Use subagent-driven-development and TDD. First adapters and readonly catalog, then import/explicitresume, then version-bound review/revision. Keep original sessions and provideridentity; never claim takeover of a running external process. Two-column UI with disclosures, no workflow dashboard, no frozen art changes. Existing task-scope spec remains authority.

The protocol evidence below comes from installed Claude SDK0.2.116 and local Codex CLI0.153.4 generated app-server types. Verify installed interfaces during implementation; use synthetic fixtures in tests, not private user histories. Root integrates/commits each stage after tests and review. No reapproval needed for approved scope.

## 新核对到的原生协议（只读依赖与代码生成，没有读取历史）

Claude 安装依赖 [sdk.d.ts:831](/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:831) 已导出 `listSessions({dir?,limit?,offset?,includeWorktrees?})`。`includeWorktrees` 默认 true，选定文件夹的精确导入必须显式 false，再核对返回 cwd。[SDKSessionInfo:3004](/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3004) 包含 `sessionId,summary,lastModified,fileSize?,customTitle?,firstPrompt?,cwd?,createdAt?`；lastModified 单位毫秒。`summary` 是 SDK 展示标题，可能来自 custom title、自动摘要或首条 prompt，不是 CC 的陪伴摘要。

[getSessionInfo:600](/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:600) 读取单 session；missing/sidechain/无可提取摘要会返回 undefined，故“undefined”不能自动解释为原始文件不存在。[getSessionMessages:630](/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:630) 按 parentUuid 组成会话链，支持 limit/offset，优于把所有 JSONL 行串起来；`SessionMessage` (:3355) 给 `type,uuid,session_id,message`，未承诺每条 timestamp。默认不含 system；仍需过滤工具和 harness 文字。

本轮仅运行 `codex app-server generate-ts --out /tmp/cc-workbench-protocol-audit-20260912`，版本输出 `codex-cli 0.153.4`。没有启动 app-server、没有 list/read/resume 用户历史。生成的 [ThreadListParams.ts:8](/tmp/cc-workbench-protocol-audit-20260912/v2/ThreadListParams.ts:8) 已有：

```ts
// Codex 0.153.4 已核对字段；不是推测
const params = {
  limit: 50, cursor: null, sortKey: 'updated_at', sortDirection: 'desc',
  sourceKinds: ['cli', 'exec', 'vscode', 'appServer'],
  archived: false, useStateDbOnly: true, searchTerm: '',
};
// thread/list -> {data:Thread[],nextCursor:string|null,backwardsCursor:string|null}
// Thread: id, sessionId, parentThreadId, name, preview, cwd,
//         createdAt, updatedAt, status, path, turns
// thread/read({threadId,includeTurns:false}) -> {thread:Thread}
// thread/items/list({threadId,cursor?,limit:100,sortDirection:'asc'})
// -> {data:{turnId:string,item:ThreadItem}[],nextCursor,backwardsCursor}
```

[Thread.ts:17](/tmp/cc-workbench-protocol-audit-20260912/v2/Thread.ts:17) 的 `id` 才是 resume threadId；:20 `sessionId` 是树内共享 ID，不能当恢复身份。`updatedAt` 是秒，归一化为毫秒；title 优先 `name`，然后 `preview`，并标派生来源。排除 parentThreadId 非 null 的子 agent。[ThreadListParams.ts:41](/tmp/cc-workbench-protocol-audit-20260912/v2/ThreadListParams.ts:41) 写明默认 list 会扫描 JSONL 修复元数据；设置 `useStateDbOnly:true` 避免目录查询主动修原生库，界面说明“已索引历史”。v1 不保证显示从未进入原生索引的旧 rollout，也不在后台偷偷修复。原生 `notLoaded/idle` 仅属于当前 app-server 所知状态，仍不等于其他程序未持有会话。

`thread/items/list` 能按页取 userMessage/agentMessage，不用 `thread/read(includeTurns:true)` 一口气加载巨型历史。生成类型 [ThreadItem.ts:33](/tmp/cc-workbench-protocol-audit-20260912/v2/ThreadItem.ts:33) 明确区分 hookPrompt、reasoning、commandExecution、functionCallOutput，默认导入排除它们。将精简的上述接口和合成响应放入仓库测试 fixture，勿提交整个临时协议树。

## Task 5A: 原生历史目录与只读正文预览

**Files:**
- Create: `src/core/workbench/native-history.ts`, `native-history.test.ts`, `native-claude-history.ts`, `native-claude-history.test.ts`, `native-codex-history.ts`, `native-codex-history.test.ts`（均在同目录）。
- Modify: `src/daemon/bootstrap/wire-workbench.ts`, `src/core/workbench/service.ts`, `src/daemon/internal-api/routes-workbench.ts` 与对应测试；admin allowlists 五处；`apps/desktop/src/modules/workbench.js/.test.ts`、样式。

**Interfaces:**

```ts
export interface NativeHistoryItem {
  key:string;providerId:'claude'|'codex';nativeId:string;
  title:string;titleSource:'native_custom'|'native_summary'|'first_prompt'|'fallback';
  cwd:string|null;updatedAt:number|null;remote:boolean;
  observedState:'active'|'observed'|'unknown';
}
export interface NativeHistoryMessage {id:string;role:'user'|'assistant';text:string}
export interface NativeHistoryPage {
  items:NativeHistoryItem[];nextCursor:string|null;
  coverage:'native_supported_history'|'native_indexed_history';
}
export interface NativeHistoryReader {
  list(input:{q:string;limit:number;cursor?:string;cwd?:string}):Promise<NativeHistoryPage>;
  read(key:string,input:{limit:number;cursor?:string}):Promise<{
    session:NativeHistoryItem;messages:NativeHistoryMessage[];nextCursor:string|null;
    sourceFingerprint:string;page:{limit:number;cursor:string|null};truncated:boolean;
  }>;
  currentFingerprint(key:string,input?:{limit:number;cursor?:string}):Promise<string>;
}
// GET /v1/workbench/sessions?providerId=claude&q=...&limit=50&cursor=...
// GET /v1/workbench/session?key=...&limit=100&cursor=...
```

v1 先按执行者标签分别分页，避免为了合并两种游标建全局索引。key 是服务端编码的 provider + 完整 nativeId，不是短前缀，也不是用户可替换的 transcript path。cursor 绑定 provider/q/cwd，limit1..100、q≤200、cursor≤2048字节，非法400；页为空且 native cursor尚未耗尽时仍显示“继续搜索”，不能称“没有历史”。provider协议超时15s、响应2MiB、展示每段最多40k，明确 truncated。

- [x] Claude adapter 注入 `{listSessions,getSessionInfo,getSessionMessages}`，默认生产绑定已安装 SDK；测试 mock 这些函数，绝不默认使用真实 home。map `sessionId→nativeId,cwd→cwd,lastModified→updatedAt`，依 `customTitle/summary/firstPrompt` 标 title 来源。正文只导入 user/assistant text，保留 message uuid，丢系统/tool/harness，遵循 SDK chain。目录选择 includeWorktrees=false 后再次检查返回 cwd；不从编码目录反推。SDK undefined 是“此来源不支持/不可读取”，不是自动fresh许可。
- [x] Claude q 搜索不能只过滤第一页：按 SDK offset 分页推进，最多处理一批500条后返回可继续扫描的 cursor，直到给足页面或源耗尽；cursor记录 nativeOffset和过滤 query，不设总200上限。测试匹配在第501项、空中间页、相同lastModified、路径缺失/sidechain、一个session大量消息时后页可读。list/read不调用 query/spawn。
- [x] Codex 新增专门的只读 catalog client，复用现有 `workbenchCodexArgs/workbenchCodexEnv` 与已验证 JSONL request/close姿态；只允许 initialize、thread/list、thread/read、thread/items/list，绝不调 thread/start/resume/turn/start/配置写入。可把现有 app-server 的纯 request/child-close 代码抽到 `codex-rpc.ts`，但必须保留原 adapter测试；不要为目录功能修改原执行 approval处理。native history client遇到服务端执行/权限请求直接拒绝并关闭。查询使用上节已核对参数，modelProviders省略；只查本机索引、parentThreadId非null排除。只读 API调用不等于对整个工具启动副作用作零写入承诺，文案限定“不启动任务、不修改历史”。
- [x] 从 `thread/items/list` 分页映射 userMessage中的text input和agentMessage.text；其他item一律忽略。默认返回native cursor，不在内存先积累完整历史。scope为本机；native返回的`path`不下传或直接用作任意文件读权限。旧CLI不支持这些已核对方法时返回 `native_history_unsupported`，不降级偷偷resume取内容，不伪造已支持版本。
- [x] 新测试至少包含这段关键身份断言：

```ts
const thread={id:'thread-uuid',sessionId:'shared-tree-uuid',parentThreadId:null,
  name:'Review parser',preview:'old first prompt',cwd:'/fixture',updatedAt:100,
  status:{type:'notLoaded'},turns:[]};
expect(mapCodexHistoryThread(thread)).toMatchObject({nativeId:'thread-uuid',
  title:'Review parser',updatedAt:100000,observedState:'unknown'});
```

`mapCodexHistoryThread(value:unknown):NativeHistoryItem` 在 native-codex-history.ts 定义并export供测试；对id/cwd/time/name必要字段逐项校验，不让 any 直接流入 UI。
- [x] sourceFingerprint 绑定 provider/nativeId/cwd/元数据版本与已显示消息 hash。它指“当前可观察版本与导入预览”，不宣称是整文件SHA256。源发生变化就重新准备预览，不导入 stale 内容。存入任务的选定消息 snapshot另有真正content SHA256。
- [x] 通过 `wireWorkbench` 注入 readers，service listNativeHistory/readNativeHistory 透传。新增路由同步 [route-tiers.ts:21](/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit/src/daemon/internal-api/route-tiers.ts:21)、[token-registry.ts:176](/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit/src/daemon/internal-api/token-registry.ts:176)、[Rust lib.rs:939](/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit/apps/desktop/src-tauri/src/lib.rs:939)、[workbench-proxy.ts:4](/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit/apps/desktop/workbench-proxy.ts:4) 的精确method/route表，operator凭据留在host，trusted仍403。
- [x] UI从“已有会话”入口打开两家选择、搜索/分页、历史预览；只读此步没有Continue/Resume副作用。native name/正文都按数据escape；读取失败可重试，不破坏新建草稿/原任务详情。运行本Task新测试+routes/proxy/UI/typecheck，独立提交 `feat(workbench): browse supported native session history`。

## Task 5B: 导入来源、声明已关闭后的原生恢复与窄冲突门

**Files:**
- Create: `src/core/workbench/native-adoption.ts`, `native-adoption.test.ts`, `src/core/workbench/execution-claims.ts`, `execution-claims.test.ts`。
- Modify: `src/lib/db.ts`, migration测试，`src/core/workbench/store.ts/service.ts/continuation.ts`与对应tests，`src/daemon/main.ts`、`src/daemon/bootstrap/wire-workbench.ts`、`src/core/session-manager.ts`、`src/daemon/cli-reply-handler.ts`及对应tests；import/continue route、五处allowlists、UI及tests。

**Interfaces and persistent records:**

```ts
export interface NativeSource {
  id:string;taskId:string;providerId:'claude'|'codex';nativeId:string;cwd:string;
  importedAt:number;firstDispatchedAt:number|null;
  snapshotSha256:string;observedFingerprint:string;
  selectedMessageCount:number;truncated:boolean;
}
export interface ExternalResumeDecision {
  token:string;sourceId:string;mode:'native_resume'|'fresh_context';
  blockers:string[];context:string;truncated:boolean;
}
export interface ExecutionClaim {owner:string;path:string;providerId:string;nativeId:string|null}
export function makeExecutionClaims():{
  acquire(claim:ExecutionClaim):()=>void;
  conflicts(claim:ExecutionClaim):boolean;
};
// acquire 同步比较 provider/nativeId（有ID时）或 canonical pathsConflict；重复 owner幂等。
// POST /v1/workbench/import <- {key,sourceFingerprint,messageIds:string[]}
// -> 200 {task,source:NativeSource,created:boolean}; 不运行。
// existing POST /v1/workbench/continue 增加 optional sourceClosedToken:string
// 和父代理已实现的 restartToken 并存；常规已归本工作台任务不必重新导入。
```

- [ ] Migration新增 `workbench_sources(id TEXT PRIMARY KEY,task_id TEXT UNIQUE REFERENCES workbench_tasks(id),provider_id TEXT NOT NULL,native_id TEXT NOT NULL,cwd TEXT NOT NULL,imported_at INTEGER NOT NULL,first_dispatched_at INTEGER,snapshot_sha256 TEXT NOT NULL,observed_fingerprint TEXT NOT NULL,selected_message_count INTEGER NOT NULL,truncated INTEGER NOT NULL CHECK(truncated IN(0,1)),UNIQUE(provider_id,native_id))`；这里v1 host固定本机，跨机器需将host加入唯一键但本期不启用。给 `workbench_events` 追加 nullable `source_id`，TaskEvent 公开 optional sourceId，以区分导入历史与本轮真实输出。追加迁移锁，不重排。
- [ ] import 在一个同步 transaction 内：服务端重新read所选message IDs与fingerprint → 保存精确正文snapshot blob → 创建status=interrupted,error=null的task → 写来源row及带sourceId的user/text events → task.session_id设原nativeId。不得追加新“用户执行要求”、入queue、mint token或spawn。UI对`source.firstDispatchedAt===null`且inactive显示“已导入，尚未执行”，不能写“任务完成/执行失败”；一旦开始执行则使用真实运行状态。重复导入provider/nativeId返回原task，created=false，既有成果/事件不复制。
- [ ] 初始导入预览最多选择200条/24000字符，明确保留的message IDs、段数与truncated；用户可以在原生历史预览分页看更多，不能把该任务的导入副本宣传成全量原始历史。新 `sourceId` 保留来源，`continuation.restartPreview`继续对已保存user/text events做精确当前规则，不绕过父代理的restartToken。源文件后来变动不修改已导入snapshot。
- [ ] prepareExternalResume(taskId,mode) 输出 `ExternalResumeDecision`（定义在native-adoption.ts，token为canonical JSON SHA256）：绑定task/source/provider/nativeId/canonical cwd、currentFingerprint、选定mode/上下文、最新已知hook观察时间、preparedAt及5分钟过期。UI展开文字“原 Claude/Codex 程序已关闭；从这条历史继续”，用户明确动作才带sourceClosedToken；只有fallback新开时还需父代理restartToken。后端没有token时409 `external_close_confirmation_required`；stale/expired时409 `external_close_confirmation_stale`且不append用户事件、不入队、不改source/sessionId。此声明不显示为“系统检测已退出”。
- [ ] 选择resume时要求原provider支持、cwd等于已导入来源且目录identity有效、currentFingerprint未变；选不同目录只允许明确fresh context。已知active或远程origin source直接阻止native resume。仅有陈旧hook观察可在显式声明后重核对；notLoaded/away/无hook都显示unknown而不是inactive。任务进入queue前取得source claim，真正spawn前重查fingerprint/已知活动，不在等待期间悄悄接受变更版本。
- [ ] 原生身份验证加在service的init/result事件落库之前：accepted resume ID与返回ID不同即报 `native_resume_identity_mismatch` 并关闭owned writer，保留旧sessionId和source nativeId。Codex adapter已有 thread/resume返回ID/cwd验证；Claude这层仍要验证，不能SDK悄悄开新会话就称恢复。firstDispatchedAt在已确认匹配身份并开始此轮后设置。第一次原生恢复失败绝不自动第二次fresh spawn，仍回到明确restart流程。

### 这里需要的冲突检查只有三条，不重写 SessionManager

**A. Workbench内部。** 把已有reservation同步登记到共用ExecutionClaims，继续由现有scheduler决定同目录排队。新claims主要供其他入口看见；provider/nativeId附加身份冲突检查覆盖同ID改cwd。queued、spawn pending、active、uncertain都保留claim；仅已有确认close/release路径释放。archive不得清claim。导入时查所有workbench source/session映射，已有task直接打开，不创建第二控制任务。

**B. 普通CC会话池。** 拒绝把 `boot.sessionStore.all()` 中仍登记的同provider/nativeId“收编为外部会话”，避免接管其复合alias/chat权限身份。增加 `SessionManagerOptions.workbenchConflict?:(path:string)=>boolean`，只在acquire和handle.dispatch前调用；false时原行为完全不变。增加一个只读 `hasProjectConflict(path):boolean`，覆盖cached sessions和pending spawn的path：在acquire同步登记一个pendingPaths map，spawn finally清除，list无需变wire。工作台claim前调用hasProjectConflict；claim生效后，普通CC新acquire/dispatch被该callback拒绝。cached同目录即使idle也保守拒绝新工作台claim，无须强杀/重建handle。这是小admission hook，不动池key、TTL、inFlight、LRU、resume策略。

**C. Legacy CLI reply。** 当前 `makeCliReplyCore.resume()` 另起进程且没有path/session锁；`defaultRunner`甚至会在parent exit后500ms返回而不保证整个子树退出（目标仓 `cli-reply-handler.ts:45`）。本期最小做法是不让它控制已导入/已绑定workbench的source：新增可选 `isWorkbenchSource(provider,id)` guard，在core.resume创建child前返回明确failed“此会话已在工作台，请在那里继续”。在 `main.ts` 通过thunk查询当前store映射，使导入后未来CLI `@码`也被拒绝。另用activeLegacySessions map在core.resume调用前登记完整source/path，finally只将结果标为unknown/recently-ended，不能把runner返回称已退出；工作台准备时这些source要求新声明并拒绝仍pending者。无需升级legacy runner的整个process lifecycle，更不复用它作为新工作台执行器。

上述已知冲突仍**不是跨应用锁**：非合作外部终端可在确认后一秒自行重开，同机其他daemon也不遵守内存claims。v1限制一个本机daemon，保留用户声明、原生反馈和观察窗口的文案；发现新的external hook后使未dispatch的token失效。若某版本原生恢复无法验证身份/cwd，则只交付该版本只读导入+显式fresh context，不声称已支持原生恢复。

- [ ] tests按下面具体矩阵先FAIL后实现：import不spawn/token/queue；同source幂等；篡改provider/id/path/messageIDs拒绝；missing source保持原ID；无/错/过期token零副作用；source变化/queue等待期间变化重新确认；同provider同ID双导入与不同路径resume不双控；不同source同目录queue；SessionManager pending/cached/new acquire/dispatch guard；legacy已导入source拒绝且不调用Runner；active hook拒绝、陈旧hook＋声明unknown可尝试；wrong Claude init/result ID保留原ID；两家原生失败不freshfallback；已有普通CC会话继续行为不变；取消/uncertain不早释claim。
- [ ] `wireWorkbench` 注入现成boot.sessionManager、boot.sessionStore和 `main.ts` 已在之前创建的cliEvents/legacy活动读函数。新增guard依赖通过函数注入，不从core import daemon。import route admin-only并扩展全部allowlists；continue仍现有route，仅扩展body验证。UI显示原provider/短展示ID/完整ID可展开、历史来源、声明/重开动作；不输入短码猜identity。
- [ ] 运行native-adoption/claims、service/continuation、session-manager、cli-reply-handler、routes/UI、migration/typecheck/depcheck targeted套件，独立提交 `feat(workbench): import and explicitly resume closed native histories`。真实验收前功能文案标待验证；不读取真实用户旧会话当单测。

## Task 5C: 固定成果版本的 Claude/Codex 检查与用户选择的修改

**Files:**
- Create: `src/core/workbench/handoff.ts`, `handoff.test.ts`。
- Modify: `src/lib/db.ts`及migration tests、`store.ts/service.ts`及tests、routes及五处allowlists、`apps/desktop/src/modules/workbench.js/.test.ts`、样式。

**Interfaces:**

```ts
export interface ArtifactSelection {taskId:string;artifactId:string;sha256:string}
export interface ReviewQuote {taskId:string;eventId:number;text:string}
export interface HandoffPreview {
  token:string;sourceTaskId:string;targetProviderId:'claude'|'codex';
  targetTaskId:string|null;purpose:'review'|'revision';
  request:string;context:string;artifacts:ArtifactSelection[];
  quote:ReviewQuote|null;truncated:boolean;
}
// POST /v1/workbench/handoff-preview
// <- {sourceTaskId,targetProviderId,purpose,request,artifacts,quote?,targetTaskId?}
// -> 200 HandoffPreview；不运行。
// POST /v1/workbench/handoff
// <- {token,restartToken?,sourceClosedToken?}
// -> 202 {task,handoffId,sourceTaskId}；仅此显式动作派发。
```

v1交接输入范围明确：`text/plain,text/markdown,application/json,application/vnd.cc.workbench-review+json`，最多10个用户选定artifact；目标prompt正文总体24000字符，预览列出截断。二进制/Office文件仍可在成果区查看下载，但此期不得当作“已把内容交给审核者”；返回 `handoff_artifact_unsupported`，请用户选择已生成文字/代码差异版本。这样本期代码实现→审阅闭环不需要新Office解析器、共享stateDir权限或把二进制塞base64给模型。

- [ ] Migration新增 `workbench_handoffs(id TEXT PRIMARY KEY,source_task_id TEXT NOT NULL REFERENCES workbench_tasks(id),target_task_id TEXT NOT NULL REFERENCES workbench_tasks(id),purpose TEXT NOT NULL CHECK(purpose IN('review','revision')),request TEXT NOT NULL,packet_sha256 TEXT NOT NULL,artifact_refs_json TEXT NOT NULL,quote_json TEXT,created_at INTEGER NOT NULL,source_native_id TEXT,target_native_id TEXT)`，以来源/接收task双向索引。packet通过blob helper保存不可变请求、确切文本与selected hashes；token绑定source当前对话版本、target provider/task、request、artifact triples、quote与实际传递文本。不要覆写旧handoff记录来表示下一轮。
- [ ] 单测先证明数据边界：sourceTaskA不能选择taskB的artifact；批准与否不影响用户主动发起review，但UI区分批准状态；changed hash/不存在artifact/超量/未知mime明确拒绝；同名旧新版本按id+sha选择；只读preview无spawn；quote必须是指定review task/event里的实际子串，不能凭模型自动解析出一条finding就当用户已选择。

```ts
const selected={taskId:source.id,artifactId:oldVersion.id,sha256:oldVersion.sha256};
const preview=await service.previewHandoff({sourceTaskId:source.id,
  targetProviderId:'claude',purpose:'review',request:'检查边界条件',artifacts:[selected]});
expect(preview.artifacts).toEqual([selected]);
expect(preview.context).toContain('旧版本的确切内容');
expect(spawnCalls).toHaveLength(0);
```

此例放在handoff integration fixture内，source/oldVersion由已有service+store helpers真实创建；spawnCalls由测试provider.spawn记录。新增公开方法为 `service.previewHandoff(input):Promise<HandoffPreview>` / `service.handoff(input:{token:string;restartToken?:string;sourceClosedToken?:string}):Promise<{task:Task;handoffId:string;sourceTaskId:string}>`，并在该模块输出相同接口类型，避免route自行拼packet。
- [ ] Review默认创建一个新的目标provider task，path沿用source canonical project，owner继承当前owner，原task记录不变；若同目录source仍active则review按原scheduler排队，并在真正dispatch前确认选择snapshot仍可读取。传给reviewer的是不可变snapshot文本，不让它把当前工作目录误称被选版本；prompt明确“下面是待审阅的固定版本；若检查当前文件，应分别说明差异”。没有把stateDir路径或原生私有全文授予reviewer。review不会自动修改源task，也不会自动调用外发工具。
- [ ] 单一事务/幂等：preview token对应随机handoff ID，submit相同token重试返回已创建target/handoff而不再派发；事务先创建关联记录和task，再进入现有start路径，失败留有真实failed/未开始状态，不能落下一条无来源的queued孤儿。动态取到的真实target nativeId在init验证后回填handoff来源字段，失败时保持null，不提前捏造。
- [ ] 目标review task输出的text events正常显示，源detail增加双向related handoffs summaries（source/target taskId、provider、purpose、createdAt、当前status、artifact refs）。源任务头部动作“交给 Claude 检查/交给 Codex 检查”打开预填panel，默认选择有真实来源的最新代码review artifact，用户可换旧版本；panel展示实际将发送的内容与截断，再按“开始检查”。同一个右侧工作视图可打开检查对话并一键返回原任务，保持两边草稿和滚动位置，不新增常驻第三栏。
- [ ] Revision面板从review text中由用户选择一段，携带quote与用户具体要求；targetTaskId固定原来源任务，不让任意task ID重定向。提交时使用该目标任务原provider和现有continueTask的decision/令牌。原Codex session可resume则仍使用原ID；不能resume则preview明确显示父代理的restart context且等待matching restartToken，绝不为方便新建无关联Codex任务。quote、来源packet版本及选择artifact triples均写新handoff记录，purpose=revision。只执行一次用户选择，不根据review回复自动再送一轮。
- [ ] 测试全部往返：Codex A输出v1→Claude B收到精确v1→B给两条意见→用户选择第二条→A收到第二条quote而非整份自动指令→A生成v2；A原sessionId和v1 hash保持，B有独立sessionId，两条handoff完整可查。另测重复submit、源active同目录排队、文件更改不偷换artifact版本、revision busy/archive拒绝、需要restart时无token零副作用、task切换/迟到preview不覆盖draft。运行handoff/service/routes/UI/migration/typecheck/depcheck，独立提交 `feat(workbench): record artifact-bound review and revision handoffs`。

## Task 6: 合成数据集成与两家真实闭环验收

**Files:** 新建 `scripts/workbench-native-history-smoke.ts`（显式手动运行的受限脚本）、`docs/superpowers/reports/2026-09-12-cc-native-history-handoff-validation.md`；按实际最后日期可更新报告日期。现有 `external-cli-contract.live.test.ts` 面向Cursor/agy，不能拿来冒充这两家的验收。

- [ ] 单测默认只使用tmpdir+mock/native合成responses，设置测试reader roots/injectedSDK，绝不默读用户home。先跑上述targeted suites和typecheck/depcheck；不因read-only文档任务执行真实CLI模型调用。
- [ ] 在用户已授权该功能真实验收的执行阶段，脚本只创建专用临时项目，使用现有workbench配置/权限语义分别建立一条Claude与一条Codex原生会话并关闭；记录本脚本确切ID，只按这些ID发现/导入/继续，不扫描展示用户私有历史。调用仍遵循本机已配置权限，不启用dangerously绕审批。不要为隔离测试重写用户HOME/CODEX_HOME或原生全局配置。
- [ ] 分别证明原ID续接读取了第一轮的一个随机nonce并产生第二轮输出，返回身份等于指定source nativeId，cwd等于临时项目；new session也能复述公开prompt不算恢复证明，nonce只存在第一轮原生历史。停止/拒绝审批、source文件不再可用、app-server返回不兼容策略均如实失败。仅生成协议/读README/文件exists不算live通过。
- [ ] 在另一个临时repo预置一条用户修改，跑Codex实现→code-review快照→Claude检查→用户选一条Codex修订。核对baseline始于取得目录占用之后，预置修改被标preexisting，固定v1仍能读，v2新hash，两个native IDs和两条handoff provenance完整。mock UI的完整点击路径与真实受控请求都须有记录。
- [ ] 浏览器使用临时daemon与synthetic fixtures，检查历史分页/错误/导入声明/恢复失败/成果旧版本/quote选择/返回原任务/草稿隔离。通过才在报告写每家工具版本、执行命令范围、具体成功或未测项；unsupported/unknown不写成接管。
- [ ] 自审spec第三段：已有CLI历史可读、在已声明关闭且无已知冲突时同ID恢复、记录交接与版本、用户选择的revision回原会话、一处读懂完整过程。提交验收报告与需要的小修，父代理最后按真实证据总结；不发布或推送。

## 取舍与必要边界核对

| 问题 | 本期结论 |
| --- | --- |
| 是否需要接管已运行外部进程 | 不需要，spec明确不承诺；只接受用户声明已关闭后的原生恢复尝试 |
| 是否需要整个SessionManager重构 | 不需要，只加workbench冲突callback和pending path只读检查；原池策略不改 |
| 是否必须修legacy runner整个进程树关闭 | 不需要用于新入口；禁止legacy再启动已归工作台的source，并记录正在legacy运行的来源即可；其退出结果不充当外部安全证明 |
| 是否需要手写Claude JSONL metadata parser | 不需要，当前安装SDK已有list/info/messages；fixture验证其链路和局限 |
| 是否需修改用户原生数据库来发现Codex | 不需要，useStateDbOnly查询已索引目录；未索引旧rollout清楚说明当前范围，后续只读walker独立增加 |
| 是否需要任意Git命令API/新第三栏 | 不需要，后台固定只读采集生成不可变成果，复用现有artifact/detail通路 |
| 是否能说差异都是agent改的 | 不能，只能说两次目录观察之间变化；原有dirty可同时存在 |
| 是否先建多执行者通用工作流/任务树 | 不需要，两个独立task/session和明确双向handoff记录足以完成验收 |
| 是否自动给另一执行者原生完整历史/个人记忆 | 不允许，只有预览中用户选择的task文字、quote、固定artifact版本；截断有披露 |



## Task 5A verification — 2026-09-12

Installed protocol types and SDK signatures checked locally. All tests use injected synthetic histories; no private native history was read during QA. 317 focused workbench/backend/proxy/UI tests pass; full typecheck passes. Browser exercised Claude/Codex listing, original conversation preview, closing the dialog and retaining an unsent current-task draft. Runtime activity remains explicitly unknown; no read operation starts/resumes a model task. Whole-operation deadlines bound multi-page reads; read failures have explicit retry. Independent agents were unavailable (account usage / local worker compatibility), so root performed adapter review and boundary tests locally. Tasks5B–6 remain outstanding.


## Task 5B implementation decisions and verification — 2026-09-12

Implemented import, explicit native/fresh continuation, source identity checks at acceptance and dispatch, admin route boundaries, source-labelled history, and daemon-local conflict guards. Source snapshots are small bounded JSON stored in the same SQLite transaction as source/task/events instead of a separate blob: this makes import atomic; SHA256 still pins the exact snapshot. Each page's descriptor/fingerprint is explicit. Tokens are opaque random server-side capabilities with a five-minute lifetime, bound to source, mode, exact recovery text, directory identity and task version; no mutable last-preview cache. They do not survive a daemon restart.

The current CLI event hub has no authoritative active/exited field. We do not invent one: native reports of active and known remote origins are blocked, ordinary CC registered/cached/pending/closing sessions and legacy pending writers are guarded. A legacy process return without positive close proof retains its in-memory conflict until service restart. No claim of an external cross-app/process lock is made. Native sources that changed since import can be prepared again against their current observable version; the original imported snapshot stays immutable. Already-managed native history offers Open task.

Synthetic browser exercise: browse → read → import without execution → type follow-up → explicit closure declaration → same fake session result/artifacts. Import status uses a neutral 尚未执行 label; original history is labelled separately. Known stale, expiry, queue-change, mismatched ID, conflict, explicit fresh restart, admin route, source snapshot and migration cases have regression coverage. 375 focused tests and full typecheck passed before final migration fixture/copy cleanup; final counts are recorded in the validation report.

Real controlled test (owned temporary projects only): Claude SDK0.2.116 and CodexCLI0.153.4 each created and closed a two-message native session, then CC read/imported/resumed that exact ID. A random marker appeared only in turn1; both models recovered it on turn2 without re-supplying it. Both second turns completed with original identity preserved. Raw owned QA results are in /private/var/folders/yc/y9bc_lbd69z5_3_dqbt5bn6c0000gn/T/cc-native-live-IbI6ix/results.json. No pre-existing personal sessions were read. Recorded review/revision handoff is still next.
