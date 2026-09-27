# 给协作者的小手册

规矩只有一份:[AGENTS.md](./AGENTS.md)(三条硬规矩 + 标准回路),维护者手册在 [docs/maintainer/README.md](./docs/maintainer/README.md)。这页只说外部 fork-PR 怎么进来。

- **从 `dev` 起分支,PR 打到 `dev`**;`master` 只接受 dev→master 的 squash PR(发版,见 [docs/maintainer/release.md](./docs/maintainer/release.md))。
- 本地四道闸门:`bun run test` / `npm run test:node` / `bun run typecheck` / `bun run depcheck`。
- commit 用 [conventional commits](https://www.conventionalcommits.org/) 风格,PR 标题就是 squash 后的 commit。PR 描述写 **Why**,不是 What。
- 用 AI 写代码可以,四个坑:别顺手改无关代码(单 PR 单意图);测试盯断言别信 mock;`typecheck` 过 ≠ API 存在,可疑函数名 grep 源码;secrets 别进 commit。
- CI 红了不知道为啥:`wechat-cc ci triage --wait` 会分桶(绿 / 真红 / 没跑 / 已知 flake),细则 [docs/maintainer/ci-and-flakes.md](./docs/maintainer/ci-and-flakes.md)。
- merge conflict:`git fetch origin dev && git rebase origin/dev`,解冲突,`git push --force-with-lease`。

仓库的设计原则(功能少 / clean / 不 SaaS 风)先看 [`README.md`](./README.md);定了什么、为什么,看 [`docs/全景导图.md`](./docs/全景导图.md)。
