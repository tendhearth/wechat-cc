# CC 工作台 v1

用户已确认：普通文件夹 → 交代任务 → 查看进展 → 预览/确认成果 → 微信明确续接同一任务。工作和生活共用 CC 身份，但不共用执行会话。此稿记录该批准范围内的实现决策。

## 范围

新增「工作台」页面，保留「此刻」与普通聊天。初版使用已注册的 Claude / Codex 两个执行后端，不新增模型、账号、ACP、自动路由、并行智能体或外部进程接管。不改冻结 CC 资产。无 Git 的普通文件夹同样可用。不会自动发送文件给联系人。

任务包含稳定八位编号、标题、文件夹、执行后端、创建/更新时间、状态、会话标识和事件。SQLite 保存；页面刷新不丢任务。状态为 queued/running/cancelling/completed/failed/cancelled/interrupted。一次只执行一个工作台回合，重复提交返回 busy。重启将未结束任务标成 interrupted，绝不自动重跑可能产生副作用的操作。

## 执行与权限

复用 AgentProvider，独立任务会话；不复用主人的陪伴会话或注入生活记忆。工作台默认 strict + trusted 工具策略，不打开 dangerously。原有工具权限机制继续生效；不把“成果确认”当成工具授权。现有后端的沙箱能力不同，页面不声称全机文件隔离。

支持可信的 session resume；恢复条件不满足时清楚记录重新建立会话并携带本任务有限历史。一次回合结束必须出现 result 才标 completed；错误、取消和流意外结束分别记录。后台持有 busy token，页面离开不取消任务。用户可明确停止，停止期间不得另起任务直到底层结束。

任务指令包含选定工作目录和 `.cc-workbench/<id>/` 成果目录。要求保留原始输入，除非用户明确要求修改；所有待交付文件放成果目录。权限范围由实际后端控制，提示词不是安全隔离。

## 成果

在执行程序确认退出后，完成/失败/取消的已生成文件均可查。服务异常退出时，已保存快照仍可查，尚未收集的文件保留在原成果目录，事件显示完整路径；不假设子进程随服务一起退出，也不自动重跑或收集。仅收集成果目录中的常规文件，拒绝符号链接和越界路径；每件最多 8 MiB，每轮最多 100 件。按 SHA-256 在应用状态目录中保存不可变快照，任务记录显示所有版本。支持文本/Markdown/CSV、PNG/JPEG/WebP、PDF、DOCX/XLSX/PPTX 的预览或下载；不执行生成的 HTML/SVG/脚本。文本用转义文本展示，Office 文件下载查看，不能假称有完整 Office 编辑器。

「确认这份成果」只确认指定文件快照与哈希，后续新版本仍待确认。读取、确认、下载只凭已登记的 task/artifact ID，不接受任意文件路径。候选文件不自动发微信。

## 微信

仅配置的 owner 可用 `任务 <编号>` 查询和 `任务 <编号> <补充要求>` 续接；`任务 <编号> 停止` 取消。未带编号的普通聊天保持原行为，不猜测当前任务。非 owner 不得获得任务存在性、文件或文本。使用与桌面完全相同的服务和锁。owner 变更后旧任务不得自动授权给新 owner。主动推送不在初版范围。

## API / 页面契约

所有路径 admin-only，由宿主代理请求，不把 operator token 交给页面。

- GET `/v1/workbench`: `{tasks,providers:[{id,displayName}],defaultProvider,canWechat}`。
- GET `/v1/workbench/task?id=...`: `{task,events,artifacts}`。
- POST `/v1/workbench/create`: `{title?,path,providerId,text}` → 202 `{task}`。
- POST `/v1/workbench/continue`: `{id,text}` → 202 `{task}`。
- POST `/v1/workbench/cancel`: `{id}` → 202 `{task}`。
- GET `/v1/workbench/artifact?id=...&artifactId=...`: `{name,mime,contentBase64,size,sha256}`。
- POST `/v1/workbench/approve`: `{id,artifactId,sha256}` → `{ok:true}`。

Task: `{id,title,path,providerId,status,createdAt,updatedAt,error:string|null}`。
Event: `{id,taskId,kind:'user'|'text'|'tool_call'|'system'|'error',text,createdAt}`。
Artifact: `{id,taskId,name,mime,size,sha256,createdAt,approvedAt:number|null}`。

布局：左侧最近任务，中间对话/进展，右侧成果（窄屏折叠）。空态只有文件夹、任务要求和已连接服务选择。macOS 桌面提供原生文件夹选择，其他平台与浏览器预览保留路径输入。首轮端到端验收以 macOS 为准；Linux 的安全文件读取已实现但未做实机验证，Windows 成果收集尚不支持。录入不因轮询重绘丢失。加载失败不展示为“没有任务”。

## 验收

真实 SQLite + 可控 AgentProvider 测试：独立任务、连续回合、流事件、错误、取消竞态、重启恢复、目录越界、符号链接、文件版本确认。真实 HTTP 验证 admin/trusted 访问隔离与非法请求。微信 owner/非owner/显式编号行为测试。浏览器用真实页面模块和标注的样例数据检查空态、执行中、成果/错误、窄屏；不把模拟截图当作真实模型办公测试。全仓 typecheck 和覆盖改动的测试通过，未实际跑的模型/微信/原生操作明确记录。
