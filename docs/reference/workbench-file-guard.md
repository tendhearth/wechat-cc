# 工作台文件锚定层的威胁模型(现状)

> 2026-10-01 首版。owner 在评审 #3 的两条路里选了 (a):保留纯 JS 的锚定文件访问(`src/core/workbench/anchored-fs.ts`,不恢复原生 `openat`),把它防什么、不防什么写清楚,并用回归测试钉住。代码是唯一事实源:`anchored-fs.ts` 与 `anchored-fs.threat-model.test.ts`(本文每一条都对应其中一条用例)。历史:2026-09-16 从 `bun:ffi` 的 openat 换成纯 JS,原因见 [cc-workbench.md 修订记录](../cc-workbench.md#修订记录)。

## 它守的是哪几扇门

锚定层是三处文件读写的共用底座:

- **成果**:执行者在项目里产出的文件,读出来给桌面 / 微信看(`artifacts.ts` → `readAnchoredFile`)。
- **附件**:主人上传的附件落到状态目录,开工前再落一份到项目的 `.cc-workbench-inputs/<任务>/<附件>/`(`attachments.ts`)。
- **API 文件 / 托管工作区**:上传分片(`attachment-uploads.ts`)与托管工作区目录(`managed-workspaces.ts`)。

共同点:路径的一部分来自 agent 或用户能影响的地方(项目里的目录结构、文件名),读写的结果会离开本机(发到微信)或写进 agent 的工作目录。

## 防什么(在范围内,必须拒)

失误和项目里的路径把戏 —— agent 写错了一个链接、项目里本来就有个指向家目录的软链、用户给了个奇怪的文件名:

| 把戏 | 怎么拒 | 钉住它的用例 |
|---|---|---|
| `..`、`.`、空段、带分隔符 / NUL 的名字 | `isPlainPart` 逐级按字面拒,在解析任何东西之前 | 「`..` in a relative name is refused…」 |
| 锚点里带 `..`(`<root>/link/..`) | `plainBase`:内核会先跟进 link 再取父目录,`path.join` 却按字面消掉,两边指向不同目录 ⇒ 锚点里有点段一律拒 | 「a base containing `..` after a link…」(2026-10-01 加固;现有调用方都传规整路径,不是在用的洞) |
| 任何一级是软链接(含指回项目里面的) | 逐级 `lstat`,是链接就拒;链接一律不跟,不去判断它指向哪 | `every level of a nested path…`、`a link that points back inside…` |
| 叶子是悬空链接,想借 `O_CREAT` 在外面建文件 | 叶子 `O_NOFOLLOW` + 打开前后都核 | 同上 |
| macOS 大小写别名(`LINK/` 对 `link/`) | 别名 lstat 到的还是那个链接本身 ⇒ 拒;别名指向项目里真实文件 ⇒ 允许(没越界) | `an alias spelling of a link…` |
| Unicode 归一化别名(NFC / NFD) | 同上,APFS 两种写法解析到同一个链接 | `NFC and NFD spellings…` |
| Windows junction(不需要权限就能建,是 Windows 上最现实的"链接") | lstat 报为链接 ⇒ 拒,包括大小写别名 | `a junction at any level…`(只在 win32 跑) |
| Windows ADS(`f.txt:hidden`)、尾点 / 尾空格别名(`docs.` = `docs`) | win32 上组件里出现 `:` 或以点 / 空格结尾一律拒,不去猜系统怎么归一化(**2026-10-01 新加**) | `ADS and trailing dot / space aliases…` |
| Windows 8.3 短名(`PROGRA~1`) | 短名是同一个目录项的另一个名字:短名指向链接 ⇒ lstat 到的还是链接 ⇒ 拒;指向真目录 ⇒ 在项目里,允许。不单独建用例(8.3 生成在很多卷上是关的,夹具搭不稳) | — |

## 不防什么(范围外)

**与我们并发、专挑两次 `lstat` 之间换目录的恶意本机进程。** 它已经以主人的身份在跑,能直接读写主人能读写的一切,不需要绕我们这一层。纯 JS 没有 `openat`,逐级 `lstat` 是多个时刻的观察,这条缝是有意接受的。

但"先开再核"(打开之后从锚点把整条链再 lstat 一遍,并核对 `fstat(fd)` 与 `lstat(叶子)` 的 `(dev, ino)`)能顺带抓住大多数换法。下表是**确切的**接受行为,都有用例钉着:

| 换法 | 结果 | 用例 |
|---|---|---|
| 预检之后、打开之前,某一级目录被换成链接 | **拒**(复核看见链接) | `caught: a parent swapped for a link…` |
| 打开前换成链接、打开后精确换回原目录 | **拒**(复核时叶子的 inode 与描述符不同) | `caught: swapped for a link before the open and swapped back…` |
| 带 `O_CREAT` 打开时上一级被换 | **拒**,但内核已经在外面建了一个**空文件**:我们不写内容、不交出描述符。这个空文件是接受的残留 | `caught: O_CREAT through a parent swapped mid-open…` |
| `mkdirAnchored` 建完一级、建下一级之前,上一级被换成链接 | **拒**(每一级都从锚点重核整条链;只 lstat 新建那一级会穿过已被换掉的上一级)。下一级的 `mkdir` 可能已经在外面建了个空目录 —— 接受的残留(**2026-10-01 修的洞**) | `caught: mkdirAnchored notices…` |
| 项目里一个**硬链接**指向项目外的文件 | **放行**,读到外面的字节。一条不含链接的路径解析到项目外,只有硬链接与挂载点能做到,`openat` 方案同样拦不住;能建硬链接的进程本来就能把内容复制进项目。上传分片另外要求 `nlink === 1` | `accepted (out of scope): a hard link…` |
| 挂载点 | 同硬链接,放行;要挂载本来就要更高的权限 | — |

## 用法上的一条规矩:从锚点开整条链

`openAnchored(base, parts, …)` 里 **`base` 是可信锚点,它自己的祖先不核**(要核祖先用 `verifyFromFilesystemRoot`,托管工作区就是这么做的)。所以:

- `base` 应当是项目目录或状态目录本身;
- **不要**拿 `mkdirAnchored` 交回来的深层路径当 `base` 去开文件 —— 那样打开后的复核看不见中间几级。

2026-10-01 之前附件落盘(`.cc-workbench-inputs/…`)正是这么写的:目录建好之后、文件打开之前,把 `.cc-workbench-inputs` 换成指出去的链接,附件内容就写到了项目外,且复核通过。现在 `attachments.ts` 的 `withDirectory` 把锚点 `{root, parts}` 一并交给写入方,`writeImmutable` 从项目目录开整条链。用例:`attachments.test.ts` 的 `re-verifies the whole chain from the project…`;这条契约本身由 `accepted (contract): the base is trusted…` 钉住。

## 什么时候要重新审视

- 工作台开始在**不信任的多用户机器**上跑,或者 daemon 以高于主人的权限读写项目(那时"并发恶意进程已有同等权限"这条前提不成立);
- 有了不经过主人账号就能往项目里写东西的入口(比如远端同步把别人的文件直接落进项目)。

到那时再考虑 roadmap 里的另一条路:macOS / Linux 恢复原生 `openat`(注意它对硬链接与挂载点同样无能为力)。
