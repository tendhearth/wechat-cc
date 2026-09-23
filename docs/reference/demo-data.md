# Demo data

> 从根 README 搬到这里(2026-09-22),README 只留门面与指路。索引见 [docs/INDEX.md](../INDEX.md)。

A fresh install means empty memory and zero observations. To preview what a
populated dashboard looks like:

```bash
wechat-cc demo seed                   # 3 observations + 1 milestone + 5 events
wechat-cc demo unseed                 # remove them
wechat-cc demo seed --chat-id <id>    # specific chat instead of default
```

Stable `obs_demo_*` / `ms_demo_*` ids make `unseed` reliable.

---
