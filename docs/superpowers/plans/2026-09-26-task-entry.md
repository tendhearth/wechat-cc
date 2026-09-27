# 统一交办 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, with independent reviews at the marked boundaries. superpowers:subagent-driven-development is also supported if the execution arrangement changes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已配置好 CC 的用户，在电脑或手机直接交办一件事、交材料、看成果，并在同一事项接着修改。

**Architecture:** 在现有 WorkbenchService 上加统一入口，不重写执行系统。服务端管理独立工作目录和持久创建回执；桌面、手机共享同一事务，手机上传分块后进入原附件存储。成果、审批、问题和续接继续复用原有 task/matter/run。

**Tech Stack:** TypeScript、Bun/Node、SQLite、原生 JavaScript/CSS、Tauri、既有手机内联页面与加密隧道、Vitest/Chromium。

**Spec:** [第一批设计](../specs/2026-09-26-task-entry.md)。基线 origin/dev@39cf7f5f543587bffaae07c1cf2557948ffaf8b1；实现进度见各任务勾选与同目录 task-entry-validation 记录；实施已同步到 origin/dev@261a2ca1。

## Global Constraints

- 本任务按用户要求采用协作隔离：只在codex/cc-task-entry及已分配工作区开发。dev供整合者集成；不得操作他人工作区。以下路径相对本任务仓库根，分工见[协作说明](2026-09-26-cc-agent-coordination.md)。
- 保留旧 create/createWechat、项目、导入、恢复、审批和免审确认契约。
- 适用已配置主人与工作台执行者的安装；没有 owner/provider 时明确提示，不能伪造身份或静默换服务。
- EntryInput/EntryContext/EntryReceipt/EntryOptions 及路由命名以设计为准；新客户端 UUIDv4；projectId 只认 service.projects() 的 catalog ID。
- 受管根默认 join(homedir(),'CC','Tasks')，与 stateDir 双向不重叠；0700；每项独立目录；归档不删除。
- 标题120字符；摘录最多10条、总共8,000字符；组合输入20,000字符；不得静默截断。
- 图片5MiB、文件8MiB、单批8件/24MiB、总暂存256MiB、未绑定7天；每owner最多32个未完成上传；上传块128KiB；加密帧和封装页面均小于512KiB。
- 保留此刻/一起做/回忆与原角色视觉。手机经典脚本、内联构建、首script/T约定；不引新框架、不加 IndexedDB。
- 每项提交前只暂存本项明确文件；数据库迁移只追加，编号按执行时最新基线；生成物由 build:mobile 产生。
- 在隔离测试数据与目录中验证；计划不授权改写真实私人记忆或发送测试微信。

## Review Focus

以下五类容易被主流程遗漏，已分配到对应任务的测试：

1. 接受后目录移动、默认执行者改变或附件暂存被清理：重复请求仍返回原事项，任务3。
2. 断电发生在目录分配与事务提交之间：重试不多建目录、不删除未知内容，任务2/3。
3. 等待回执时用户换事项或编辑新稿：迟到响应不得清稿、跳错事项，任务5/6/9。
4. 图片中间块或最后块回包丢失，且设备随后被撤销：恢复字节准确、旧设备不能继续，任务7/9。
5. 受管临时事项积累后污染项目列表或抢同一目录租约：项目选择保持真实、两个事项可独立运行，任务2/3/5。

## 文件与责任

| 责任 | 新建模块 | 主要接入点 |
| --- | --- | --- |
| 输入与创建登记 | src/core/workbench/task-entry.ts、entry-store.ts | service.ts、store.ts、src/lib/db.ts |
| 独立工作位置 | src/core/workbench/managed-workspaces.ts | anchored-fs.ts 复用，wire-workbench.ts 接线 |
| 手机分块材料 | src/core/workbench/attachment-uploads.ts | attachments.ts、mobile-workbench.ts |
| 桌面预览 | apps/desktop/src/modules/task-entry.js | converse.js、main.js、workbench.js |
| 手机新交办与附件控件 | apps/mobile/src/entry.js、entry.css、attachments.js、attachments.css | phone.html、presence.html、workbench.js、transport.js |
| 材料投影与续说 | 不另建执行器 | src/core/matters/service.ts、已有 workbench submitInput/continueTask |

同名测试紧邻模块。service.ts、settings-panel.ts 和 db.ts 的改动由同一整合者串行落地。任务1–4是后端基座；任务5–6完成文字；任务7–9完成材料；任务10整体验收。

---

### Task 0: 开工基线与计划归档

**Files:** 读取 AGENTS.md、docs/maintainer/README.md、verify.md、migrations.md、apps/mobile/README.md；在本任务独立工作区保存 docs/superpowers/specs/2026-09-26-task-entry.md 和 docs/superpowers/plans/2026-09-26-task-entry.md，复制对应设计与本计划并更新互链。

**Interfaces:** 消费已确认的本任务工作区；产出实现基线 SHA、当前失败清单及验收记录 docs/superpowers/plans/2026-09-26-task-entry-validation.md。

- [x] 核对codex/cc-task-entry、起点提交、未提交改动和远端关系，保留所有既有工作；不得检出或改动他人使用的dev。
- [x] 阅读维护者要求，记录实际 owner/provider 条件和可用真机，不读取凭据内容。
- [x] 运行基线 `bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`。记录失败原文与归属；无未解释的新失败才开始相应模块。
- [x] 将设计/计划归档到上述路径并提交：`docs: plan unified task entry`。不把外部个人截图复制进仓库。

### Task 1: 输入契约和持久创建登记

**Files:** Create src/core/workbench/task-entry.ts、task-entry.test.ts、entry-store.ts、entry-store.test.ts；Modify src/lib/db.ts、src/core/workbench/attachments.ts；Test src/core/workbench/attachments.test.ts、src/lib/db.test.ts、state-migration.test.ts、migration-order.test.ts。

**Interfaces:** 从设计导出 EntryInput、EntryContext、EntryReceipt、EntryResult、EntryOptions。新增：
~~~ts
parseEntryInput(value: unknown): EntryInput
canonicalEntryHash(input: EntryInput): string
createEntryStore(db: Database): EntryStore
~~~
Database沿用仓库db类型。EntryStore提供 get(ownerKey,requestId)、reserve(reservation)、accept(ownerKey,requestId,accepted)；事务由service持有。EntryReservation包含请求hash、冻结目标/执行者/材料、workspaceId与分配状态；EntryAccepted增加设计列出的完整回执和目录身份。store不调用模型、不创建目录、不启动执行者。

- [x] 写输入/迁移/唯一键测试，钉住未知字段拒绝、UUID、长度和有序材料的hash：
~~~ts
expect(canonicalEntryHash(a)).not.toBe(canonicalEntryHash(reorderedAttachments))
expect(() => parseEntryInput({ ...valid, path: '/tmp/x' })).toThrow()
expect(store.get(owner, requestId)?.phase).toBe('reserved')
~~~
其中 a、valid、reorderedAttachments 为本文件明示的有效夹具；测试同owner同ID异内容冲突、不同owner隔离、accepted缺字段拒绝、升级保留旧任务。
- [x] 运行 `bun run test src/core/workbench/task-entry.test.ts src/core/workbench/entry-store.test.ts src/lib/migration-order.test.ts`，确认失败指向缺少新契约或表。
- [x] 实现严格解析与确定性hash，追加workbench_entry_requests、任务workspaceKind（旧值默认project）及workbench_attachments.owner_key迁移。省略与显式默认区分；accepted回放只需规范输入hash，不访问当前暂存材料。附件仅StoredAttachment增加ownerKey，upload/select/bind/copyToTask/discard增加可信scope参数，不从body读取；旧NULL未绑定记录不自动认领，已盖章记录不能覆盖owner。为这套兼容规则先写并跑失败测试，再实现并跑attachments.test.ts。
- [x] 运行以上测试及 `bun run test src/lib/db.test.ts src/lib/state-migration.test.ts`；全部通过且原迁移顺序不变。
- [x] 提交：`feat: add durable task entry requests`。

### Task 2: 独立目录与任务归属

**Files:** Create src/core/workbench/managed-workspaces.ts、managed-workspaces.test.ts；Modify src/core/workbench/store.ts、service.ts、src/daemon/bootstrap/wire-workbench.ts；Test src/core/workbench/store.test.ts、projects.test.ts、scheduler.test.ts。

**Interfaces:** 新增 createManagedWorkspaces({root,stateDir})，返回 ensure(reservation): ManagedWorkspace、verify(workspace): void、removeEmptyCreated(workspace): boolean。ManagedWorkspace含id/path/directoryIdentity及本调用是否新建；分配身份由任务1登记持有。store.create只增加内部 registerProject?:boolean（默认true）与 workspaceKind:'project'|'managed'，不改变旧公开create参数。

- [x] 写测试：两个不同登记得到两个兄弟目录；同登记重试同目录；stateDir双向重叠、链接、身份替换、.cc-workbench*组件拒绝；出现陌生文件后不得删除。受管task不新增project、旧create仍新增。
~~~ts
expect(first.path).not.toBe(second.path)
expect(retried.path).toBe(first.path)
expect(projectsAfterManaged).toEqual(projectsBefore)
expect(removeResultForNonEmptyDirectory).toBe(false)
~~~
- [x] 运行 `bun run test src/core/workbench/managed-workspaces.test.ts src/core/workbench/projects.test.ts`，确认新目录/归属行为尚未实现。
- [x] 复用anchored-fs逐级锚定创建和身份核验；先持久登记再建目录。补“已分配但尚未记录inode”重启处理，未知非空目录保守拒绝；服务注入默认根，勿在核心读取任意用户路径。
- [x] 运行本任务全部测试，确认两兄弟目录不互斥，旧项目相同目录仍按原租约排队。
- [x] 提交：`feat: isolate managed task workspaces`。

### Task 3: 一个原子创建入口

**Files:** Modify src/core/workbench/service.ts、entry-store.ts、task-entry.ts、src/daemon/bootstrap/wire-workbench.ts；Create src/core/workbench/service-entry.test.ts；Test wechat-create.test.ts、service-matters.test.ts、service-capabilities.test.ts、service-attachments.test.ts、service-origin.test.ts（均在同目录）。

**Interfaces:** 产出 WorkbenchService.entryOptions(context):EntryOptions、createEntry(input,context):EntryResult、entryReceipt(requestId,context):EntryResult|null。消费任务1/2及原createTask/start、MatterStore、attachment select/bind、normalizeExecutionChoice/requireWorkbenchInput。组合执行输入标明要求与主人选择的讨论材料。

- [x] 用真实SQLite和受控fake provider写行为测试：LAN重复/两个连接并发只一个task/matter/user事件/accepted run；matter/binding/receipt任一写失败零spawn、零附件消费；接受后换默认provider、移动目录、清理暂存再查仍原回执；重新进程装配后结果一致。
~~~ts
expect([taskCount, matterCount, firstUserEventCount, acceptedRunCount]).toEqual([1, 1, 1, 1])
expect(spawnCountAfterReceiptFailure).toBe(0)
expect(replayed.receipt).toEqual(first.receipt)
expect(replayed.receipt.taskId).toBe(replayed.receipt.matterId)
~~~
同时测同ID改摘录/执行设置/附件顺序409、reserved后默认配置变化仍冻结原provider、项目catalog ID解析、无owner/provider、API不支持材料、免审未确认、所选摘录之外内容不进入任务。新入口使用未绑定附件必须owner完全匹配；旧无owner材料与主人变更后的旧材料拒绝且不消费，原direct create对legacy NULL保持兼容、对已盖章材料也校验owner。
- [x] 运行 `bun run test src/core/workbench/service-entry.test.ts`，确认失败后实现。
- [x] 依设计的reserved→accepted流程接入原createTask事务；严格matter登记不吞错；提交后activate。已接受请求先回放，不重新解析默认值。冻结provider、执行设置和已验证材料；origin由owner resolver产生，不伪造message ID。不同已配对表面的同ID回放返回原事项，并允许按owner访问已有matter。
- [x] 运行本任务全部测试；验证“提交后、spawn前崩溃”被原恢复逻辑标为可继续的中断，不创建第二项；需要新增恢复接线时在本任务实现并补测试。
- [x] 独立审查事务边界、目录故障与认证主体，修正后提交：`feat: create tasks through one atomic entry`。

### Task 4: 桌面和手机共用的窄路由

**Files:** Modify src/daemon/internal-api/routes-workbench.ts、route-tiers.ts、token-registry.ts及其现有测试；src/daemon/bootstrap/workbench-api.ts；src/daemon/mobile-workbench.ts、settings-panel.ts、wiring/pipeline-deps.ts；apps/desktop/src-tauri/src/lib.rs；apps/desktop/workbench-proxy.ts及其测试。Test src/daemon/internal-api/routes-workbench.test.ts、src/daemon/settings-panel-workbench.test.ts、scripts/route-registry.guard.test.ts。

**Interfaces:** 仅暴露设计表中的三个桌面路由和三个手机路由；SettingsPanelDeps增加窄entryOptions/createEntry/entryReceipt依赖。两端成功结果使用EntryResult；不存在回执404。owner和surface由认证接线层构造，不能信body。

- [x] 写成对授权测试：operator精确三路由通过；guest/trusted拒绝；admin session保持既有策略；未认证/撤销手机拒绝。body path/owner/account/未知字段400；伪造请求编号不能读取另一owner回执；错误稳定JSON并有对应状态码。
- [x] 运行 `bun run test src/daemon/internal-api/routes-workbench.test.ts src/daemon/settings-panel-workbench.test.ts scripts/route-registry.guard.test.ts apps/desktop/workbench-proxy.test.ts`，确认新增端点及集合断言失败。
- [x] 注册路由、tier、operator、Rust白名单、开发代理与精确集合；手机放在现有token gate后，调用任务3，无通用/v1转发。桌面原attachment上传body不变，由服务端给任务1的可信scope盖当前owner；补原上传契约回归与body伪造owner拒绝测试。
- [x] 重跑以上测试；运行 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml workbench_request`，确认新路径放行、近似前缀和未列路径拒绝。若现有Rust测试名不同，先列出精确测试名并记录再运行，不把0 tests算通过。
- [x] 提交：`feat: expose authenticated task entry adapters`。

### Task 5: 桌面交办预览与默认入口

**Files:** Create apps/desktop/src/modules/task-entry.js、task-entry.test.ts、apps/desktop/src/styles/task-entry.css；Modify apps/desktop/src/modules/converse.js、workbench.js、workbench-entry.js，apps/desktop/src/main.js及其当前样式入口；Test converse.test.ts、workbench-entry.test.ts、workbench-projects.test.ts、workbench-organization.test.ts（同modules目录）；Modify scripts/workbench-companion-browser-smoke.ts。

**Interfaces:** 新模块导出 createTaskEntry(deps)，返回 open(draft):Promise<EntryResult|null>。Draft={text,visibleMessages?:{role:'user'|'cc';text:string}[]}；UI内部管理requestId/draftId/materialSignature；deps提供既有API、附件控件和成功导航。converse.onDelegate改收Draft；旧“已有项目新建”继续原入口。

- [ ] 写测试：预览默认不选聊天；带上最近五轮最多10条，error/system/pending不出现；发送输入只含所选摘录；取消保留文字；接受后仍在编辑的新稿不清；重复点击同请求；options catalog ID正确；受管任务归“随手交办”，原项目列表不多UUID项目。
~~~ts
expect(initiallySelectedExcerpts).toEqual([])
expect(selectedExcerpts).toHaveLength(10)
expect(retainedNewDraft).toBe('再补一份要求')
~~~
- [ ] 运行 `bun run test apps/desktop/src/modules/task-entry.test.ts apps/desktop/src/modules/converse.test.ts apps/desktop/src/modules/workbench-entry.test.ts`，确认新交办路径失败。
- [ ] 实现独立预览模块和此刻/无项目空态入口。完整展示最终要求与材料；更多收起项目/执行设置；默认不可用保留草稿并显示原因。成功只按匹配回执清对应稿、打开原matter；详情可查看并打开受管位置。
- [ ] 重跑本任务测试；运行 `bun scripts/workbench-companion-browser-smoke.ts`，检查宽/窄窗口、键盘焦点、取消返回、真实公开摘录，保存截图和结果于验收记录。
- [ ] 提交：`feat: hand off owner requests from desktop`。

### Task 6: 手机文字交办与回执恢复

**Files:** Create apps/mobile/src/entry.js、entry.css、apps/mobile/entry.test.ts；Modify apps/mobile/src/phone.html、presence.html、presence.js、workbench.js、globals.d.ts；Modify src/daemon/__e2e__/mobile-workbench.e2e.test.ts、src/daemon/mobile-page-workbench.test.ts；Regenerate src/daemon/mobile-page.generated.json。

**Interfaces:** 经典脚本新增 openEntry()、submitEntry()、restoreEntry()；用任务4的entry/options、matter/create和create-receipt。新草稿key独立于matter续说草稿；保存requestId与草稿版本，taskId来自回执。不在本任务额外加入普通闲聊的新API。

- [ ] 写浏览器/存储测试：无项目能交办；LAN已接受但回包丢失后隧道重发只一个事项；刷新用原requestId查回执；新输入不被迟到回包覆盖；切任务不被旧响应拉回；离线显示尚未确认并留稿。任务公开对话默认可见、工具细节仍折叠。
- [ ] 运行 `bun run test apps/mobile/entry.test.ts src/daemon/mobile-page-workbench.test.ts`，確認新入口测试失败。
- [ ] 按原页面组合约定接入表单；选项默认managed；更多只列服务返回的可用执行者与项目；请求已送出但结果不明时不生成新requestId重试。用户明确另开新事时才分配新ID。
- [ ] 执行 `bun run build:mobile`，重跑本任务测试及 `bun run test:e2e src/daemon/__e2e__/mobile-workbench.e2e.test.ts`；确认页面封装预算、草稿隔离和文字闭环。
- [ ] 提交：`feat: start and resume tasks from phone`。这一提交仅完成文字，整个第一批尚未交付。

### Task 7: 有界、可恢复的手机分块上传

**Files:** Create src/core/workbench/attachment-uploads.ts、attachment-uploads.test.ts；Modify src/core/workbench/attachments.ts、service.ts、src/daemon/mobile-workbench.ts、settings-panel.ts、wiring/pipeline-deps.ts、src/lib/db.ts；Test attachments.test.ts、src/daemon/settings-panel-workbench.test.ts、src/lib/migration-order.test.ts。

**Interfaces:** createAttachmentUploads(deps)返回 chunk(input:UploadChunk,context:EntryContext):UploadState、status({id,draftId},context):UploadState、discard({id,draftId},context):void。实现设计中的三条/m/api/attachment路由。正式完成只调用原uploadAttachment；UploadState对手机只暴露安全附件元数据。

- [ ] 写真实字节测试：128KiB块重复内容幂等，乱序/错hash/元数据冲突409，最后块丢回包重试返回同ready；重启核验部分文件；受管新任务与已有任务draft隔离；伪造owner/path拒绝；撤销设备后全部上传路由拒绝。空块、超限个数/磁盘预留、ready丢临时文件和取消后重试也必须有确定结果。
~~~ts
expect(repeatedFinal.status).toBe('ready')
expect(repeatedFinal.attachment?.id).toBe(firstFinal.attachment?.id)
expect(finalizedAttachmentCount).toBe(1)
expect(allEncryptedFrameByteLengths.every(n => n < 512 * 1024)).toBe(true)
~~~
- [ ] 运行 `bun run test src/core/workbench/attachment-uploads.test.ts src/daemon/settings-panel-workbench.test.ts`，确认协议缺失失败。
- [ ] 追加workbench_attachment_uploads表：owner/id/draft/task、固定元数据、状态uploading/finalizing/ready/discarded/expired、已提交offset与块摘要、预约空间、到期时间。按设计原子预约与SQLite同步短事务串行写块，不跨await；首块前检查32个未完成上传及磁盘峰值。重启截回未提交尾部，短文件/摘要错拒绝；finalizing按同附件ID恢复，成功盖owner后转ready。discard与清理共用状态机，已绑定或有效reserved引用返回409；取消墓碑阻止复活，过期解除未接受预约，最小身份记录保留。测试两并发首块争最后配额、写字节后DB失败、blob落盘后ready失败、取消与末块同时到达四条故障路径。
- [ ] 重跑本任务测试及原attachments.test.ts；使用真实加密LAN/隧道handler传输大于512KiB图片，验证所有帧和最终hash。
- [ ] 独立审查路径/配额/重复最终化后提交：`feat: upload phone materials in resumable chunks`。

### Task 8: 同一事项材料投影和接着改

**Files:** Modify src/core/matters/service.ts、src/core/workbench/service.ts、live-inputs.ts（按现有材料回执实现所需），src/daemon/settings-panel.ts；Test src/core/matters/service.test.ts、src/core/workbench/service-attachments.test.ts、live-inputs.test.ts、src/daemon/settings-panel-workbench.test.ts。

**Interfaces:** MatterEvent、MatterInput新增只含id/name/mime/size/sha256的材料元数据；MatterSayInput增加draftId?:string、attachmentIds?:string[]。继续现有say→submitInput/continueTask；原续说回执hash覆盖有序附件和归属，不能只比文字。

- [ ] 写测试：图片only新建与补充成功；活会话/已结束会话均拿到同一真实附件；跨draft/task/owner材料拒绝；同requestId改附件顺序409；无需base64即可在detail确认附件；运行中补充处于held时不显示送达。超大历史详情仍遵循现有分页/裁剪及帧约束。
- [ ] 运行 `bun run test src/core/matters/service.test.ts src/core/workbench/service-attachments.test.ts src/core/workbench/live-inputs.test.ts`，确认材料在matter边界丢失的用例失败。
- [ ] 实现材料投影和输入传递，统一各层“空文字有材料”校验；维持原run/request绑定、恢复确认和审批。新手机材料严格核验owner；旧已绑定NULL材料经原task.owner_chat_id核验后复用，copyToTask不能丢owner。遇到需要桌面恢复确认的两类错误保留图文并明确指引，测试不能假报已接收。身份边界不从UI状态推断。
- [ ] 重跑本任务测试和settings-panel-workbench，验证首轮/续说各自回执不混用、同一task/matter/目录保持。
- [ ] 提交：`feat: preserve materials across task continuations`。

### Task 9: 手机选图、上传状态与任务材料

**Files:** Create apps/mobile/src/attachments.js、attachments.css、apps/mobile/attachments.test.ts；Modify entry.js、workbench.js、transport.js、phone.html、globals.d.ts；Test apps/mobile/entry.test.ts、src/daemon/__e2e__/mobile-workbench.e2e.test.ts；Regenerate src/daemon/mobile-page.generated.json。

**Interfaces:** 经典脚本createPhoneAttachments({draftId,taskId?,onChange})返回 select(files)、resume(files)、remove(id)、readyIds()、signature()、dispose()；网络使用任务7路由，signature包括有序id/hash/size。新建和续说使用各自实例。transport的b64u外部接口不变，只内部有界分段编码。

- [ ] 写控件/浏览器测试：照片选择→分块上传→ready才可提交；刷新后重新选同文件续传、错文件拒绝；取消/换事项不串预览；全空文字+ready照片可提交；HEIC明确说明；软键盘下按钮可用；大密文字节数组base64来回一致且无整数组apply。
- [ ] 运行 `bun run test apps/mobile/attachments.test.ts apps/mobile/entry.test.ts`，确认新控件未实现。
- [ ] 实现选图、进度、重试/移除和任务材料展示；localStorage只保存元数据。每个回包核对id/draftId/taskId/size/sha256及当前上传代次；取消使用新ID重选，迟到响应无作用。输入编辑不等待上传；未ready不能冒充已交材料；clear条件含requestId+文字+材料signature。已发提交快照的材料不能先删除，结果未知先核对回执；用户新草稿另行保留。详情展示实际接收/held状态。
- [ ] 运行 `bun run build:mobile`、以上测试、`bun run test apps/mobile/build.test.ts`、`bun run test:e2e src/daemon/__e2e__/mobile-workbench.e2e.test.ts`，验证最终帧/页面大小和迟到响应。
- [ ] 提交：`feat: attach and continue phone tasks with materials`。

### Task 10: 整批验收、文档与交付

**Files:** Modify docs/superpowers/plans/2026-09-26-task-entry-validation.md、docs/maintainer/mobile-presence.md；按实际已交付内容更新docs/roadmap.md、docs/INDEX.md、docs/全景导图.md（若修改总图，仅运行生成命令更新HTML）；必要时更新README现有能力描述。

**Interfaces:** 消费任务1–9；产出可核查验收记录（版本、测试命令、结果、截图、限制），每条区分自动化/真实执行者/原生窗口/真人手机。

- [ ] 执行 `bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck` 和手机生成同步检查；全部要求通过，既有失败逐项说明而非改成“通过”。
- [ ] 用独立测试目录及无隐私材料走真实执行者：桌面聊天选五轮材料→新事项→手机看成果→补大图修改→桌面打开同一事项与文件；验证真实模型确实读到图片。已配置Claude Code、Codex等执行者按能力分别记录，未测的不得写成支持已验收。
- [ ] 在真实Tauri窗口及手机Safari/微信内置浏览器验收：照片选择、键盘、切后台、刷新、Wi-Fi到移动网络、回包丢失、恢复确认、成果保存。同请求始终一件事，至少一次超过512KiB图片完整上传。
- [ ] 独立整批审查；修正后只重跑受影响验证与必要整合闸门。确认旧微信创建、项目入口、任务恢复与成果下载未回归。
- [ ] 依据docs/maintainer/deploy.md构建sidecar，再交给主人ggshr9串行完成原子部署与健康检查；使用维护者规定的workbench/chat selftest，明确测试消息的接收范围。无真机时保留该框未完成、交付状态标为待真机验收。
- [ ] 更新上述文档与验收记录并提交：`docs: record task entry acceptance`。由明确整合者推dev后按CI triage要求确认结果；master只通过PR squash，创建PR后附加到本对话。

## 自审结论与暂停点

本计划覆盖设计的三个入口、事务/目录、默认执行者、聊天摘录、手机文字与材料、续接/草稿、权限/路由及真实验收。双方分工已由主人转达确认；本方第一批先行，ggshr9负责合dev和部署。产品代码与部署均未开始。

实施中若发现无法在同一SQLite事务登记matter、现有恢复逻辑不能涵盖提交后崩溃、或已确认目录身份不能可靠恢复，应先收窄并修订相应设计与测试，再继续其依赖任务；不能用吞错、重复创建或自动删除来“打通流程”。
