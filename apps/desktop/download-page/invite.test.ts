/**
 * 下载页的「朋友邀请」形态。
 *
 * 背景(2026-08-31):找朋友测试社交层时,装机和配对是两个时间尺度 —— 装机
 * 十几二十分钟、朋友一个人做;配对三十秒、两人都在场最顺。硬要一条链接同
 * 时干这两件事,就会撞上配对码 10 分钟 TTL 的墙(那个短窗口是有意收紧的,
 * 不该为迁就装机而拉长)。所以拆开:**这一页只负责把人带进来**,配对仍走
 * 微信里的 6 位码。
 *
 * 因此这一页【绝不携带任何密钥或配对码】—— 只有一个用于打招呼的名字。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8')

describe('下载页 —— 邀请形态', () => {
  it('有邀请横幅的骨架,默认隐藏(直接访问的人不该看到"谁邀请你")', () => {
    expect(HTML).toMatch(/id="invite-banner"/)
    expect(HTML).toMatch(/id="invite-banner"[^>]*\shidden/)
  })

  it('[hidden] 必须显式压过 display:flex,否则"默认隐藏"形同虚设', () => {
    // 2026-08-31 真浏览器验证抓到的:光写 hidden 属性没用,.invite 的
    // display:flex 会赢。纯字符串断言看不出这种 CSS 覆盖,所以把结论钉在这。
    expect(HTML).toMatch(/\.invite\[hidden\]\s*\{[^}]*display:\s*none/)
  })

  it('读 ?from= 参数,并且对它做转义(它进 DOM,是不可信输入)', () => {
    expect(HTML).toMatch(/from/)
    expect(HTML).toMatch(/textContent/)          // 用 textContent 而非 innerHTML 落名字
    expect(HTML).not.toMatch(/innerHTML\s*=\s*[^\n]*fromName/)
  })

  it('装完之后的四步在页面上(此前装完就断片,没人告诉朋友下一步干嘛)', () => {
    for (const step of ['扫码', '大脑', '社交', '配对码']) {
      expect(HTML, `缺少「${step}」这一步`).toContain(step)
    }
  })

  it('页面不携带任何配对码/密钥(拆分设计的核心不变量)', () => {
    // 配对码是一次性密钥、10 分钟 TTL,必须走微信当面给,不能进可转发的链接
    expect(HTML).not.toMatch(/pair(ing)?[_-]?code\s*=/i)
    expect(HTML).not.toMatch(/[?&]code=/)
  })

  it('仍然保留原有的平台识别与 Release 单一事实源', () => {
    expect(HTML).toContain('releases/latest')
    expect(HTML).toMatch(/id="btn-primary"|id="dl-slot"/)
  })
})
