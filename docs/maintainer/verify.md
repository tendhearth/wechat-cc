# 验证

改完 + 部署完,用 `wechat-cc selftest` 做真机闭环。它不发微信、不碰主人的聊天记忆、不改主人的默认 provider。

推上去之后还有最后一步 —— **看 CI**,也是一条命令:

```bash
wechat-cc ci triage --wait --rerun
```

退出码 0 绿 / 1 真红(`unknown` 也算)/ 2 这个 SHA 上没有运行、`gh` 出错、或开关写错了 / 3 是 `src/cli/ci-flakes.json` 里登记过的 flake。给了 `--rerun` 的话已知 flake 会自动重跑一次,**第二次仍红一律改判真红**。细则、退出码全表、怎么往登记表里加一条,见 [ci-and-flakes.md](ci-and-flakes.md)。

## 两种用法

```bash
wechat-cc selftest workbench --executor cursor [--image] [--resume] [--json] [--timeout-ms N] [--keep]
wechat-cc selftest chat --provider cursor [--text "…"] [--resume] [--json] [--timeout-ms N]
```

**workbench**:在 `<tmpdir>/wechat-cc-selftest/wb-<ts>` 建一个 scratch 项目(mkdir + README + `git init` 一次提交),`POST /v1/workbench/create`,长轮询 `GET /v1/workbench/task`,碰到权限卡就 `POST /v1/workbench/permission` 放行;跑完(或超时)时任务状态还没到终态就先 `POST /v1/workbench/cancel` 并最多等 20s,再 `POST /v1/workbench/archive`。检查项:`created`、`replied`、`text_seen`、`activity_seen`、`permission_roundtrip`、`file_written`(`--image` 时换成 `answer_mentions_red`)、`resume_replied`(带 `--resume` 时)、`no_error_event`、`archived`(归档那一下的 HTTP 结果本身也是一项)。

scratch 项目**不在 STATE_DIR 底下**(它跟 token / account.json 同级,而 scratch 里跑的是权限全放行的真执行者);跑完默认删掉,`--keep` 保留它、把路径打在 `scratch: …` 那行上给人去翻现场。daemon 侧 `selftest chat` 用的 scratch 项目同理,固定在 `<tmpdir>/wechat-cc-selftest/project`。

`--timeout-ms` 是**整轮**上限(workbench 缺省 240000;chat 缺省 180000,daemon 侧轮次看门狗缺省 120000)。非数字 / ≤0 当场报错退 1,不会悄悄按缺省值跑。

**chat**:`POST /v1/selftest/converse { providerId, text }`,daemon 内部代 spawn 一次自检对话。检查项:`replied`、`tool_seen`(缺省 text 让它调 wechat MCP 的 `ping`)、`no_error`、`resume_replied`。那次对话的会话 token 只被授予 `GET /v1/health`、并且带 10 分钟 TTL —— 自检对话里的 wechat MCP 只能 ping,发不出消息。

刚 `self deploy` 完就跑 `selftest chat` 是**正常用法**:端口和 info 文件比 bootstrap 接线早,那个窗口里路由会答 503 `selftest_not_wired`,CLI 每 2s 重试、最多等 60s,等到了就在 `replied` 的 detail 里写一句 `waited …ms for selftest wiring`。

输出:逐行 `✓ / ✗ name — detail`,末行 `PASS` / `FAIL`;`--json` 给 `{ ok, kind, target, checks, taskId?, sessionId?, durationMs, scratchPath? }`。退出码 0 通过 / 1 有检查项失败 / 2 daemon 没在跑。

## 两种 token 分别够得着什么

daemon 起来后写 `~/.claude/channels/wechat/internal-api-info.json`,里面有 `baseUrl`、`tokenFilePath`、`operatorTokenFilePath`。**两把钥匙不通用**:

| | 文件 | 档 | 够得着 |
| --- | --- | --- | --- |
| file token | `tokenFilePath` | trusted | `GET /v1/health` 这类 trusted 路由 |
| operator token | `operatorTokenFilePath` | admin,但按 `routeAllow` 逐条放行 | 工作台那一串、`POST /v1/selftest/converse`、桌宠权限 resolve 等 |

**operator token 拿不到 `GET /v1/health`** —— 它不在 `routeAllow` 里,拿它去戳 health 会 403 `route_not_allowed`。健康探测一律用 file token。`routeAllow` 的口径是「桌面 app / CLI 真会调的那几条」,不调的就不给;新路由要加请看 `src/daemon/internal-api/token-registry.ts` 里的注释。

手动戳一下:

```bash
INFO=~/.claude/channels/wechat/internal-api-info.json
BASE=$(python3 -c "import json;print(json.load(open('$INFO'))['baseUrl'])")
FILE_TOKEN=$(cat "$(python3 -c "import json;print(json.load(open('$INFO'))['tokenFilePath'])")")
curl -s -H "Authorization: Bearer $FILE_TOKEN" "$BASE/v1/health" | head -c 400
```

报告里永远不要贴 token 原文;要证明读到了就贴长度或哈希前 8 位。

## 工作台路由名(照抄,别凭印象)

```
POST /v1/workbench/create        { path, providerId, title, text, draftId?, attachmentIds? }
GET  /v1/workbench/task?id=&since=&wait_ms=20000      长轮询,返回 events + permissions
POST /v1/workbench/permission    { id, requestId, decision: 'allow' | 'deny' }
POST /v1/workbench/continue      { id, text }
POST /v1/workbench/cancel        { id }
POST /v1/workbench/archive       { id, archived: true }
POST /v1/workbench/attachment    { id, draftId, name, mime, base64 }
```

## 必须主人在场的检查清单

`selftest` 覆盖不到的、只有人眼能判的四件事(改了相关代码就请主人跑一遍):

1. 桌面 app 在本仓库 `cd apps/desktop && bun run tauri build` 之后,任务里的**逐字流**是真的一个字一个字出来,不是整段蹦出来;
2. **免审执行者**(agy / cursor)第一次要输入时,桌面弹的那张确认对话框能点、点完不再问;
3. 「**改动**」面板里逐文件「接受 / 打回」按下去有效,打回的文件下一轮真的回到执行者手里;
4. 微信里一句真的 `/cursor …`,回一条、只回一条(对话侧协调器一条 text 事件发一条微信,流式 provider 必须按助理消息攒)。
