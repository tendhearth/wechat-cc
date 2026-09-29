# 手机「此刻」接线

本轮把 `apps/desktop/art/cc-mobile-companion/` 第二版设计接到现有 `/m` PWA,复用原有手机配对、直连/隧道、matter 详情与审批接口。没有另建权限系统或改生产数据结构。

> 2026-09-24 起页面源码在 [`apps/mobile/src`](../../apps/mobile/README.md),改完跑 `bun run build:mobile`;daemon 只读生成物 `src/daemon/mobile-page.generated.json`。下文提到的 `mobile-presence-view` / `mobile-workbench-client` 已并入 `apps/mobile/src/presence.*` / `workbench.js`,测试改名为 `mobile-page-presence` / `mobile-page-workbench`。

## 页面和数据

- **此刻**: `/m/api/home` 的真实 presence,未知时明确说不知道。没有信号就不声称正在画画。Light / Dark 使用冻结正身,仅在页面到来时淡化亮起,不跟网络或主题切换。
- **待处理入口**: home 响应的 `work.focus` 只带任务 ID、标题和分类。打开后重新读 `/m/api/matter`,决定依然绑定 task/run/request 三个 ID,不能拿首页缓存直接批准。
- **成果**: 最近 24 小时更新的已完成任务、有保存成果时给出入口。进入任务后,无待决请求时自动校验并预览首张不超过 8MB 的 PNG/JPEG/WebP;其他文件仍通过原有查看/下载入口。公开对话默认可见，工具细节保持折叠。
- **回忆**: 原事件流及分页。待办、画像、表情收在可展开区域,没有删除这些功能。只有打开回忆才推进 seen 水位,打开首页不再自动把全部历史标成已读。

`mobileHomeFocus` 最多读取最近 200 个未归档任务,8 个一组读取本地详情。达到窗口上限、来源缺失或详情读取失败时返回 `partial`,页面提示概览可能不完整,不宣称所有任务都已检查。它不是全量任务索引,下一阶段应复用专门的待决索引,避免规模扩大后的反复详情读取。

## 断线与提交

一次详情请求失败即禁用审批和发送;连续两次联系失败再显示连接提示。浏览器 offline 事件立即禁用。断线、切后台和离开页面都会使在途详情失效,旧响应不能重新启用提交或撤销断线提示。输入草稿仍然可编辑,恢复连接并重新取得详情后才允许提交,不自动重发。

请求失败后,新的详情里请求仍在时提示仍在等待;请求消失只能说明它结束、过期或被别处处理,不能称本次提交成功。服务端现有 stale 检查和重复请求处理仍是最终边界。补充消息继续使用原有 requestId 与送达回执,匹配送达后才清草稿。

## 冻结图片与验证

`bun scripts/build-mobile-presence-art.ts` 将两张冻结 PNG 原字节嵌入 JSON,供编译后的 sidecar 和隧道页面使用,无需运行时访问源码路径。测试校验原文件、摘要和嵌入字节一致,并检查页面经过 base64 封装后仍低于 512KB。

定向回归覆盖 `mobile-home-focus`、`mobile-page-presence`、`mobile-page-workbench`、`settings-panel`、`settings-panel-workbench` 和 `core/matters/service`。浏览器验收使用隔离数据,检查首页到任务、审批、图片预览、补充送达和断线恢复。真机软键盘、微信内置浏览器与公网隧道仍需部署后验收。

本轮仅在独立开发分支交付,不重启共享 daemon。整合者合入并验证后,按维护者标准回路构建、部署和真机自检。

## 本轮交接验证（2026-09-23）

- 定向 Bun / Node 各 6 文件、65 项通过;typecheck 通过;depcheck 0 error、7 条既有循环依赖 warning。
- 全仓 Bun: 8517 项通过、1 项失败;全仓 Node: 7224 项通过、1 项失败。两者都是 `src/lib/state-migration.test.ts:114` 仍断言数据库版本 63,实际为 65。数据库和该测试均未被本轮修改;整合前必须处理并重跑,不能视为全仓通过。
- 隔离浏览器走通待决定、审批、图片完整性校验、补充送达和断线保留草稿;390px 视口未溢出。尚未部署或完成手机真机验收。
- 本分支还包含前置协作约定 `aff049e4` 和获准设计稿 `8b701a10`;整合者应先核对是否需要一同引入,避免覆盖其他执行者已更新的协作规则。

## CC 眼中的你(2026-09-26)

「此刻」点 CC 进入 `p-you`:一封信的样子(手写一句、「昨晚」便签、五栏按承诺→关于你→偏好→身边的人→近况)。显示派生全部由 daemon `src/daemon/memory/memory-text.ts` 算好,经 `/m/api/memory` 下发;眨眼帧 256px 全彩经 `/m/api/art/blink` 懒加载,不进页面(守 512KB 中继帧)。源码 `apps/mobile/src/you.{js,css}`。


## 统一交办与材料（2026-09-27 开发分支）

已配置主人与执行者时，「此刻」可以直接交办，无需先建项目。默认每件事独立工作目录，更多选择使用服务端项目和执行者列表。新交办使用持久 requestId 和创建回执；直连丢回包、切换隧道或刷新后先核对原请求，不另建事项。手机不提供执行恢复方式的替代确认，遇到需要恢复确认的任务保留草稿并提示到桌面处理。

材料按 128 KiB 分块上传，图片上限 5 MiB、文件 8 MiB、每批 8 件/24 MiB；同一 owner 最多 32 个未完成上传。桌面完整上传与手机分块共享 256 MiB 预算，包含临时文件、孤儿文件、待写入空间和记录开销。未提交材料与未接受的创建预约保留 7 天；绑定到事项或仍被有效预约引用的材料不能取消。取消记录阻止迟到上传重新出现。刷新只保存元数据，继续未完成上传需要重选原文件并校验摘要。

手机接口仍在原配对 gate 后：`entry/options`、`matter/create`、`matter/create-receipt`，以及 `attachment/chunk`、`attachment/upload`、`attachment/discard`（均为 `/m/api/` 下的精确路由）。owner 由服务端解析。新建回执与同事项补充的 run/request 回执分开；详情材料只投影 id/name/mime/size/sha256，不携带文件路径或 base64。

开发分支验收见[统一交办验证记录](../superpowers/plans/2026-09-26-task-entry-validation.md)。本节不代表已部署；Tauri 窗口、真实执行者看图、手机 Safari/微信键盘和网络切换仍需整合者验收。
