# 第一批设计：同一件事从交办到成果修改

状态：待实施设计；代码基线 origin/dev@39cf7f5f543587bffaae07c1cf2557948ffaf8b1。用户要求制定计划。范围和排期见[总计划](../plans/2026-09-26-cc-user-experience.md)。

## 用户路径

在桌面或手机“此刻”直接写要求、加材料，点击“交给 CC”。默认由 CC 分配一处独立工作位置；更多选项允许选已有项目、执行者和原有执行设置。提交后进入原任务的连续对话，既有审批、问题、成果和补充继续生效。

桌面聊天交办先打开一张预览，包含当前要求和可选最近对话摘录。用户检查后点击“开始”；取消保留原输入。选择摘录意味着把这部分私人聊天用于本项工作；不复制整份聊天，不注入个人记忆权限。手机新交办本期是明确的任务动作，不自动猜测闲聊意图。

没有可用执行者时，保存草稿并提示连接条件。已经接受的任务始终保持原任务身份；重试绝不能重新选执行者或开另一件事。

## 范围与非目标

本期适用已配置主人身份与至少一个可用工作台执行者的现有安装。未绑定微信时独立本地主人身份属于后续首次使用批次；本期不能用假 owner/account 填补它。

保留全部旧 create/createWechat、项目任务、导入和恢复接口。继续使用 task.id === matter.id、原排队器、原 runId、权限、问题、成果快照、续说回执。没有新执行器、没有全局自动模型路由、没有手机离线执行或原生推送。已有微信通知按现有订阅与归属规则工作，不伪造出处来开启回报。

受管事项只归档、不自动删目录。用户能在详情看到保存位置并从桌面打开。手机不能传本机绝对路径。

## 共同接口（本设计为唯一命名依据）

以下为拟新增契约；旧接口保持兼容。

```ts
type EntryTarget =
  | { kind: 'managed' }
  | { kind: 'project'; projectId: string }

type EntryExcerpt = { role: 'user' | 'assistant'; text: string }
type EntryInput = {
  requestId: string
  text: string
  title?: string
  target: EntryTarget
  providerId?: string
  execution?: unknown // 仍由 normalizeExecutionChoice 校验
  draftId?: string
  attachmentIds?: string[]
  context?: {
    source: 'owner-chat'
    excerpts: EntryExcerpt[]
  }
}
type EntryContext = {
  ownerKey: string
  surface: 'desktop' | 'phone'
}
type EntryReceipt = {
  requestId: string
  taskId: string
  matterId: string
  runId: string
  acceptedAt: number
}
type EntryResult = { receipt: EntryReceipt; task: WorkbenchTaskView }

entryOptions(context: EntryContext): EntryOptions
createEntry(input: EntryInput, context: EntryContext): EntryResult
entryReceipt(requestId: string, context: EntryContext): EntryResult | null
```

EntryOptions 固定如下；WorkbenchExecutorCapabilities复用executor-capabilities.ts现有类型，ProjectCatalogEntry复用project-catalog.ts现有类型：

```ts
type EntryOptions = {
  status: 'ready' | 'needs_connection'
  reason?: { code: string; message: string }
  defaultProviderId: string | null
  providers: {
    id: string; displayName: string
    available: boolean
    unavailableReason?: { code: string; message: string }
    capabilities: WorkbenchExecutorCapabilities
  }[]
  projects: ProjectCatalogEntry[]
}
```

projects来自service.projects()；项目ID只接受该catalog的p-20hex，不能接受store.projects()的p-UUID。列表不暴露凭据，不自动把不支持材料的执行者变成可选默认；attachments:true不能被解释为支持PDF/Office等所有格式，实际仍由原provider输入校验决定。

| 桌面内部接口 | 手机薄适配 |
| --- | --- |
| GET /v1/workbench/entry-options | GET /m/api/entry/options |
| POST /v1/workbench/create-entry | POST /m/api/matter/create |
| GET /v1/workbench/entry-receipt?requestId= | GET /m/api/matter/create-receipt?requestId= |

手机接口只做认证、形状校验和调用同一个 WorkbenchService；不把 MatterService 改为另一个执行系统。

ownerKey 必须来自服务端已配置主人身份；surface由调用入口决定。请求体严格拒绝 path、ownerKey、ownerChatId、accountId 和其他未声明字段。EntryContext.origin 不接受客户端自由填写：存在 context.source 时，服务端解析该主人的 owner-chat matter，确认归属并记录 originMatterId；没有已保存消息 ID 则 originMessageId 为 null。摘录标明“主人选择的讨论材料”，不冒充数据库中的权威原始消息，不当作系统指令。

requestId、draftId、attachmentId 使用现有 UUID 校验规则；新客户端生成 UUIDv4。标题沿用120字符上限。摘录至多10条，合计不超过8,000字符；最终组合要求沿用工作台20,000字符限制，超出明确要求缩减，不静默截断。空文字但有有效附件允许提交。

## 创建事务、幂等与受管工作目录

新增小模块：
- task-entry.ts：形状校验、规范化请求、原文材料组合、默认选择。
- entry-store.ts：渠道无关请求登记、分配身份、已接受回执。
- managed-workspaces.ts：根目录、创建及目录身份检查。

新增 workbench_entry_requests 持久表，键为 ownerKey + requestId，记录 canonicalRequestHash、phase（reserved/accepted）、workspaceId、resolvedPath、目录身份、冻结的 provider/execution/materialSnapshot、taskId/runId/acceptedAt。reserved允许没有taskId，accepted要求完整关联。数据库迁移只向末尾追加，编号以执行时最新 migrations.length 为准。

规范化哈希覆盖用户实际请求：文字、标题、target、显式provider/execution、draftId、**有序**attachmentIds和摘录。省略默认与显式选择保持区别。接受时另存已核验附件的有序大小/哈希快照；回放只对照冻结请求与已接受材料，不重新读取可能已清理的暂存文件或已改变的默认配置。

流程：
1. 认证并校验形状。先按主人+requestId读登记：同内容accepted直接返回原回执；不同内容409 creation_conflict；不得启动执行者。
2. 没有登记的新请求核验材料、执行能力与目标，再按显式执行者→所选项目执行者→已配置工作台默认解析一次。已有同内容reserved请求沿用冻结的provider/execution/materialSnapshot与分配身份，只复核其当前可用性和材料完整性；不重新选择默认。不可用即报错；改变选择或材料须使用新requestId。无静默收费服务切换，既有免审确认继续生效。
3. 固化reserved分配身份。受管根由接线层注入，默认 join(homedir(),'CC','Tasks')；每个事项独立服务端UUID子目录。路径不能来自标题、requestId字符串拼接或上传文件名。根与stateDir双向不重叠，拒绝 .cc-workbench* 组件、符号链接及身份变化。目录权限0700。
4. 同一SQLite事务创建task、首条用户事件、执行设置、附件绑定、matter、surface binding、accepted回执和目录关联。复用现有createTask/start的提交后activate扩展点。新入口要求matter登记成功；不能沿用matterSync吞错。任一写失败→整批回滚、零spawn、附件仍可重试。
5. 提交后activate原执行逻辑，返回taskId===matterId。提交后进程崩溃而尚未派发时，重试只返回已接受任务；启动恢复沿用既有interrupted语义，用户可继续，不能自动重复新建。
6. 两进程/两通道同requestId竞争时，唯一键与事务保证只有一个成功接受。每次reserved重试重新核验目录身份及当前能力，不能因为有reserved就绕过检查。

普通任务store.create默认仍登记项目；新受管任务通过内部明确选项跳过addProject。其task视图带workspaceKind='managed'，旧任务缺省project；UI单独聚合“随手交办”，普通项目catalog不混入UUID目录。不是给每件临时事项造一个可选项目。

文件系统不能随SQLite回滚：失败只允许删除本次创建、仍为空且身份未变的目录。不得递归删除。崩溃留下的reserved目录按登记继续核对；有未知内容则保留并明确错误。活任务/归档目录本批不做自动清理。

## 桌面聊天交办

修改converse的onDelegate输入为结构化草稿（文字、当前可见的user/cc公开消息），由独立task-entry UI打开预览。待发送、error、system行不能作为摘录。当前输入是要求；原文摘录默认不选择，一键“带上最近五轮”选择至多10条公开消息，用户可逐条取消与编辑要求。

用户最终看见将要传入的完整材料，不调用模型重写事实。没有来源就留空；带入的内容按“要求/主人选择的讨论材料”明确分隔。附件使用原暂存接口。只有接受回执与当前草稿文字、材料、requestId一致才清稿；取消、失败或用户后来编辑都保留。

旧有明确项目的工作台新建流程保留；此刻交办与无项目空态使用新入口。旧任务、执行者选择、草稿和恢复路径不因此改变。

## 手机附件和续说

新增传输模块attachment-uploads，最终仍调用既有uploadAttachment，产生既有Attachment记录。不能建立第二种成果或附件身份。

```ts
type UploadChunk = {
  id: string; draftId: string; taskId?: string
  name: string; mime: string; size: number; sha256: string
  offset: number; contentBase64: string
}
type UploadState = {
  id: string; draftId: string; taskId: string | null
  size: number; sha256: string; nextOffset: number
  status: 'uploading' | 'ready'
  attachment?: Pick<Attachment, 'id' | 'name' | 'mime' | 'size' | 'sha256'>
}
```

手机新增POST /m/api/attachment/chunk、GET /m/api/attachment/upload?id=&draftId=、POST /m/api/attachment/discard（body仅{id,draftId}）。每次认证后解析owner；taskId存在时复查当前主人与任务归属。所有元数据固定，只有顺序下一块可追加；相同offset相同字节可重放，不同字节/元数据/乱序409。最后一块完整校验SHA与原有MIME/签名后一次性转为ready。缺块或被篡改的内容不绑定到任务。

响应的id/draftId/taskId/size/sha256必须与当前控件实例、上传代次和文件一致；ready再比对全部附件元数据，才更新进度或提交材料。取消后原上传ID不得复用，迟到回包不恢复被移除控件。

每块128KiB原始字节；计入base64、JSON、加密及信封后的帧必须小于512KiB。transport的base64编码改为有界分段，避免整数组apply的参数上限。页面整体仍内联、经典脚本、首script/T约定，整页封装也须通过512KiB预算。

沿用图片5MiB、其他文件8MiB、最多8件/24MiB、暂存256MiB、未绑定7天规则。首块前在SQLite事务中原子预约原始文件及最终化峰值所需空间，部分文件、最终blob、控制元数据和崩溃遗留均计入同一配额；每owner最多32个uploading/finalizing记录。空块拒绝，未满总配额不能跳过批次限制。

每个上传串行提交：以SQLite写事务作为跨进程写锁，重新检查状态和offset后，在该事务内同步定位写、同步字节、保存offset再提交，不跨await。文件已写而offset未提交时，重启先把多余尾部截回已提交offset并重新校验；文件短于offset或已存块摘要不一致时拒绝继续。最终化先持久写finalizing意图，再用原uploadAttachment的相同ID幂等完成，最后写ready；最终blob已写而ready未提交时，重启可核验后补完，不能再产生附件。所有写入者，包括discard/清理，遵循同一锁与状态机；记录短事务耗时，避免移动传输等待占用数据库锁。

discard只移除未被任务绑定、未被有效reserved创建/续说引用的材料；被引用返回409。客户端提交期间冻结已发送材料快照，用户可另写草稿但不能删除快照材料；结果未知先查回执。取消保留最小终态墓碑，本批不回收ID；迟到chunk/status返回410 upload_discarded，重复discard成功。未绑定内容7天清理，ready/取消的最小身份记录保留以支持幂等，元数据仍计入配额。清理与旧reserved关联先标记材料过期并失效预约，再按身份删暂存内容，不触碰已绑定材料。

附件owner必须贯穿最终绑定：给workbench_attachments追加可空owner_key，仅内部StoredAttachment暴露。桌面既有upload入口和手机finalize通过可信服务端scope盖章，body不接收owner。新createEntry及手机续说/复制/删除严格验证owner；不同owner不能重试覆盖。旧无owner的未绑定草稿不能被新入口认领，提示以新UUID重新上传；已绑定旧任务材料可经task.owner_chat_id核验归属后复用。旧direct create保留legacy NULL规则，但已盖章的行不得通过旧入口绕过owner校验。内容blob仍按SHA去重，owner附着逻辑附件行。已accepted回执仍优先回放，不重查附件。

客户端只在localStorage存草稿和附件元数据。刷新后未完成的上传要求重新选择同文件并核对摘要再续；本批不新增IndexedDB。HEIC明确不支持，不能当文本提交；PNG/JPEG/WebP等依原MIME检查处理，不自动压缩改变内容。

MatterEvent和MatterInput增加安全附件元数据；MatterSayInput增加draftId/attachmentIds并传给原submitInput/continueTask。图片only首轮和补充都允许。新建回执与续说回执各自保存，不混淆。sameDraft比较同时包含文字、材料顺序与内容签名，迟到回执不清新稿。权限卡仍绑定task/run/request，不能以首页快照批准。

本批手机续接验收覆盖原会话可直接恢复的正常路径。遇到restart_confirmation_required或external_close_confirmation_required，明确显示需在桌面确认恢复、保留文字及材料，不能把该情形写成手机闭环已通过。手机完成异常恢复确认属于批次3；先记录限制，不追加未经审阅的强制恢复接口。

## 授权与错误

桌面新增精确路由同时登记route-tiers、operator routeAllow及精确集合测试、Rust workbench_request_allowed及测试、workbench-proxy，运行route-registry守卫。guest/trusted应被admin tier拒绝；admin session依现有策略，不声称全部session token都被拒绝。

手机仍在现有设备/短链接token门后服务，不开放通用/v1代理。撤销设备后新建、上传、重读、续说全部拒绝。当前设备token独立体系的迁移另行计划。

错误需稳定映射：400形状/输入不合法，401手机未认证，403身份或路由拒绝，404不存在回执/上传，409创建内容冲突/陈旧目标/上传冲突，410上传已取消或过期，413过大，503依赖未接线或受管目录不可用。已有provider/恢复/审批错误按原映射保留。未收到匹配回执只显示“正在确认是否收到”，不能清稿或写“已开始”。

## 验收

- 并发的新事项在独立兄弟目录运行；原项目任务仍按旧租约排队。
- LAN已提交丢回包→隧道重发→重启再查，仅一个task/matter/首条user事件/接受run；回执阶段不再spawn。
- 默认provider改动、目录移动、暂存已清理后，已接受回执仍指向原任务。
- matter、绑定或回执写入失败→无执行、无附件消费。
- 手机提交大于512KiB的真实图片，经加密帧进入真实执行者；产出后同任务补图修改，电脑看到同一事项和材料。
- 用户离线、换页、切后台、编辑新稿、审批过期时，页面行为真实，不串任务、不丢稿。
- 聊天五轮后选择必要摘录交办，最终执行输入包含所选内容，不包含未选私人内容。
- 没配置owner/provider的安装明确给出下一步，不冒充“所有新用户可用”。
