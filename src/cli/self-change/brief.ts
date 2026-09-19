/**
 * brief.ts —— 交给执行者的三段话,以及评审结论的解析。
 *
 * 为什么把提示词单独放一个文件:它们是这条流水线**唯一**的护栏软的那一半
 * (硬的那一半是 guard 闸门和禁改清单)。执行者在
 * `--dangerously-skip-permissions` 下跑,能做什么全靠这几段话说清楚 ——
 * 所以它们要能被单测钉住(禁改清单逐条在场、评审的输出契约在场),
 * 而不是散在某个 step 的字符串拼接里。
 *
 * 设计:docs/superpowers/specs/2026-09-18-self-change-pipeline-design.md
 * §执行者调用「系统追加提示」与 §流程与闸门 第 3 / 6 步。
 */
import type { ReviewFinding } from './state'

/**
 * `--append-system-prompt-file` 的正文(流水线写到 `<workdir>/briefs/<id>.md`)。
 * `branch` 是执行者当前所在的分支(`self/<id>`),`forbidden` 是 policy.ts 的禁改清单。
 */
export function implementBrief(input: { id: string; branch: string; forbidden: readonly string[]; exceptions?: readonly string[] }): string {
  const list = input.forbidden.map(p => `- \`${p}\``).join('\n')
  // 例外要说出来:清单里写着 `.github/workflows/**`,不说一句的话执行者会
  // 连自己这次改动的 CI 作业都不敢动(而那正是白名单放它改的)。
  const except = input.exceptions?.length
    ? `\n- 这几个是上面那几条里**挖掉的洞**,可以改:\n${input.exceptions.map(p => `  - \`${p}\``).join('\n')}`
    : ''
  return `# 自改 #${input.id}

你在 wechat-cc 的一个**专用克隆**里(当前工作目录就是仓库根),当前分支 \`${input.branch}\`。
这次改动接下来要依次过:本地测试 → 独立评审 → CI → 主人在微信里拍板 → 合进 dev → 部署 → 自检。
每一道闸门没过都会把失败原文交回给你重修,所以老老实实把事做对比赶快交差划算。

## 先读这两份
- \`AGENTS.md\`:这个仓库的规矩(风格、分层、测试怎么写)。
- \`docs/maintainer/README.md\`:维护者手册(怎么跑测试、怎么部署、怎么自检)。

## 只在这个目录里改
- 只改当前工作目录下的文件。这台机器上还有主人自己的 checkout,以及 \`~/.claude/\`、
  STATE_DIR 这些真实状态目录 —— 一律不许碰。
- 下面这些文件**禁止改动**(发版通道、签名与更新源、护栏本身、出事后的回滚配方)。
  动了其中任何一个,guard 闸门会直接判整条流水线失败:
${list}${except}

## 自己提交
- 改完**自己 \`git commit\`**,提交信息用中文写清楚为什么这么改;可以分多次提交。
- **不要 \`git push\`**,**不要切分支**、不要新建分支、不要 rebase / reset 到别处 ——
  推送、合并、部署都由流水线做。
- 收工前确认 \`git status --porcelain\` 是干净的:没提交的改动等于没有改动,
  流水线只看 \`${input.branch}\` 上的提交。

## 改动范围
- **改动范围 = 这次需求真正需要的文件。** 需求说「只改这一个文件」就只改那一个。
- 顺手看不顺眼的别的东西(测试超时、配置、夹具、无关的重构),**不要做**;
  真觉得非做不可,就**单独说明**:写在收尾那段话里,说清楚为什么它是这次需求的一部分。
- 越界的改动会被独立评审揪出来(\`scope:\` 意见),然后要你**原样还原**——
  绕一圈回到原点,还要多花一轮预算。

## 不要做的事
- 不要发微信,不要调 wechat-cc 的任何对外发送能力:进展由流水线统一报给主人。
- 不要碰 \`~/.claude/channels\`(那是主人真实会话的通道目录)。
- 不要为了让测试变绿而删测试、放宽断言或加跳过。

## 可以用的
- superpowers 的 brainstorming / writing-plans / subagent-driven-development 都在,
  该用就用(尤其是需求含糊、或者改动跨了好几个文件的时候)。
- 验证:\`bun run typecheck\`、\`bun run depcheck\`、\`bun run test\`、\`npm run test:node\`。

## 收尾
最后用**一段话**说明:改了什么、为什么这么改、怎么验的(跑了哪些命令、结果如何)。
这段话会原样进主人的拍板卡,他就看这一段决定合不合。
`
}

/** 修复轮的开场白(三处闸门各一句),后面接失败原文。 */
const FIX_HEAD: Record<'tests' | 'review' | 'ci', string> = {
  tests: '你刚才那轮改动**本地测试没过**。下面是失败输出的尾巴:',
  review: '你刚才那轮改动**被独立评审判了要改**。下面是评审给的问题:',
  ci: '你刚才那轮改动**CI 没过**。下面是 triage 的判定与失败摘要:',
}

/**
 * 测试那道闸门专有的一段:红的测试跟这轮改动没关系的时候,正确答案是**停下**,
 * 不是把超时调大、把夹具改宽。
 *
 * 2026-09-18 真机(f65f4c09):一句「只改这一个文件」的文档改动,整套测试在满载
 * 的机器上超时红了一次,修复轮里执行者顺手动了 10 个文件(vitest 超时 5s→20s、
 * 夹具、三个测试),评审只把越界记成一条 minor,于是这份 $10 的「修复」合进了 dev。
 */
const TESTS_SCOPE_RULE = `
**范围纪律(这一条比让测试变绿更重要):**
- 只准改与这次需求直接相关的文件。
- 失败的测试如果与你改的文件**无关**(别的模块、超时、机器负载),**不要去改测试、
  不要调超时、不要动配置或夹具** —— 在结束语里写明「与本次改动无关」然后停下。
- **绝不**为了让测试变绿而放宽阈值(超时、重试次数、断言的容差)。
`

/** 交回同一个会话(`--resume`)的修复说明。 */
export function fixPrompt(kind: 'tests' | 'review' | 'ci', detail: string): string {
  return `${FIX_HEAD[kind]}

${detail}
${kind === 'tests' ? TESTS_SCOPE_RULE : ''}
请在同一个克隆、同一个分支上修:先定位**真因**再动手,不要为了让它变绿而删测试、
放宽断言或加跳过。改完**自己 \`git commit\`**;仍然**不要 \`git push\`**、不要切分支。
修完用一段话说明:真因是什么、改了什么、怎么验的。
`
}

/**
 * 评审揪出越界改动(`scope:` 意见)时的修复轮:那几个文件要的不是「修」,是**还原**。
 *
 * 分开一个提示词是因为普通的 fixPrompt 会让执行者接着在那些文件上动手 ——
 * 而那些文件本来就不该被它碰过。
 *
 * 同一轮里别的 critical / important **不会**被越界那几条吞掉:`restDetail` 单起一节
 * 照常要它修。只还原不修,下一轮 guard→tests→review 还会把它们原样打回来。
 */
export function revertPrompt(input: { baseRef: string; files: readonly string[]; scopeDetail: string; restDetail: string }): string {
  const list = input.files.map(f => `- \`${f}\``).join('\n')
  const rest = input.restDetail.trim()
    ? `
## 二、这几条要**修**(和上面那几个文件无关,照常定位真因再动手)

${input.restDetail}

修完自己 \`git commit\`,用一段话说明真因。
`
    : ''
  return `独立评审认为你这轮**改了这次需求用不到的文件**(范围越界),同时还有别的问题。

## 一、这几个文件要**还原**,不要在它们上面接着"修"

评审的原话:

${input.scopeDetail}

要还原成基线 \`${input.baseRef}\` 的样子的是:

${list}

照这条命令还原,然后自己提交:

\`\`\`
git checkout ${input.baseRef} -- ${input.files.join(' ')}
git commit -m "还原与本次需求无关的改动"
\`\`\`

需求本身要的那部分改动**保持原样**,只还原上面列出来的文件。
${rest}
仍然**不要 \`git push\`**、不要切分支。
收工用一段话说明:还原了哪几个文件、为什么它们与这次需求无关;另外修了什么、真因是什么。
`
}

/** 评审轮(新会话、只读)的 prompt。输出契约写死在最后。 */
export function reviewPrompt(input: { request: string; branch: string; baseRef: string }): string {
  return `你是这次改动的**独立评审**。需求原文:

${input.request}

改动在分支 \`${input.branch}\` 上,基线是 \`${input.baseRef}\`。用
\`git diff ${input.baseRef}...HEAD\` 和 \`git log ${input.baseRef}..HEAD\` 看全部改动,
需要上下文就去读周边代码。先读 \`AGENTS.md\` 与 \`docs/maintainer/README.md\`,
按这个仓库自己的规矩评。

看这几件事:需求是不是真的实现了;有没有正确性 bug(边界、并发、错误吞掉);
有没有碰不该碰的东西(发版通道、签名、护栏、主人的凭据与真实状态目录);
测试是不是在测行为而不是在测实现;有没有把失败悄悄咽掉。

**范围也要看**:改动里有没有这次需求**用不到**的文件 —— 尤其是与需求无关的
测试超时、\`vitest\` 配置、别处的夹具(典型的「为了让红的测试变绿顺手放宽」)。
**为这次改动新增 / 调整的测试与夹具属于需求范围,不算越界**(这个仓库要求
改了行为就补测试);越界指的是与需求无关的文件。真越界了的话,
每个这样的文件报一条 \`important\`,\`file\` 写那个文件,\`summary\` **必须以
\`scope:\` 开头**(例如 \`"summary":"scope:vitest.config.ts 把超时从 5s 调到 20s,
与需求无关"\`)。流水线看到 \`scope:\` 会让执行者把那些文件**还原**,而不是接着改。
越界不是 \`minor\`。

**你是只读的:不要编辑任何文件,不要 \`git commit\` / \`checkout\` / \`push\`。**
(写工具已经关掉了;真去改了文件,这次评审会被直接判成 changes。)

## 输出契约
话可以随便说,但**最后一个 \`\`\`json 代码块**是给机器读的,必须是这个形状:

\`\`\`json
{"verdict":"approve","findings":[{"severity":"minor","file":"src/x.ts","line":12,"summary":"一句话说清问题"}]}
\`\`\`

- \`verdict\`:\`approve\`(可以合)或 \`changes\`(要改)。
- \`severity\`:\`critical\` / \`important\` / \`minor\`。有 critical 或 important 就必须判 \`changes\`;
  只剩 minor 可以 \`approve\`(minor 会原样带进主人的拍板卡)。
- 没有问题时 \`findings\` 写 \`[]\`。
`
}

const SEVERITIES: readonly ReviewFinding['severity'][] = ['critical', 'important', 'minor']
/** 解析不出 JSON 时,拿原文前多少行当那条 finding 的正文。 */
const FALLBACK_LINES = 20

const JSON_BLOCK = /```json\s*\n([\s\S]*?)```/g

/**
 * 从评审正文里取**最后一个** ```json 块(前面的多半是例子或思考过程)。
 * 取不到或解析不出 ⇒ 当 changes,并把原文前 20 行当成一条 important
 * finding —— 「评审说不清楚」本身就该回修复轮,不能当成放行。
 */
export function parseReviewVerdict(text: string): { verdict: 'approve' | 'changes'; findings: ReviewFinding[]; parsed: boolean } {
  const blocks = [...text.matchAll(JSON_BLOCK)].map(m => m[1] ?? '')
  const last = blocks.at(-1)
  if (last !== undefined) {
    try {
      const obj: unknown = JSON.parse(last)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const o = obj as { verdict?: unknown; findings?: unknown }
        return {
          verdict: o.verdict === 'approve' ? 'approve' : 'changes',
          findings: Array.isArray(o.findings) ? o.findings.flatMap(toFinding) : [],
          parsed: true,
        }
      }
    } catch { /* 落到下面的兜底 */ }
  }
  return {
    verdict: 'changes',
    findings: [{ severity: 'important', summary: text.split('\n').slice(0, FALLBACK_LINES).join('\n') }],
    parsed: false,
  }
}

function toFinding(raw: unknown): ReviewFinding[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const o = raw as { severity?: unknown; file?: unknown; line?: unknown; summary?: unknown }
  // 认不出的 severity 归 minor:一个词不该把闸门抬高成「必须回修复轮」。
  const severity = SEVERITIES.find(s => s === o.severity) ?? 'minor'
  const finding: ReviewFinding = { severity, summary: typeof o.summary === 'string' ? o.summary : JSON.stringify(raw) }
  if (typeof o.file === 'string') finding.file = o.file
  if (typeof o.line === 'number' && Number.isFinite(o.line)) finding.line = o.line
  return [finding]
}
