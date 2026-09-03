/**
 * hunt-catch.ts — 把「每日打猎」发出去的那条消息拆成可入库的猎物。
 *
 * 打猎(`buildHuntText`,kind="hunt")每天让 CC 上网找 1-2 条主人会感兴趣
 * 的东西,用 reply 发到微信。**发完就没了** —— careLedger 只记「今天打过
 * 猎」,猎到什么一个字都没存。用户反馈原话:「虽然你的 cc 有自动打猎的
 * 功能,但是桌面端没有记录」。
 *
 * 为什么不让模型自己登记(多加一个 record_catch 工具)?因为那要求模型
 * 每次都记得调,漏一次就少一条,而**漏了没人知道**。这里改成从**真发出去
 * 的那条文本**里解析 —— 发了什么就记什么,不依赖模型配合。
 *
 * 解析刻意保守:原文整段留着(`note`),标题只是给列表扫读用的**派生**字段。
 * 猜错标题最多难看,猜错正文就是丢信息。
 */

export interface CatchItem {
  /** 列表里显示的短标题(派生,不是权威内容)。 */
  title: string
  /** 链接;模型没给链接时为 null。 */
  url: string | null
  /** 这一条的原文,一字不改 —— 「为什么你会感兴趣」就在里面。 */
  note: string
}

/** 行内 URL。刻意不吃末尾的中英文标点(它们属于句子,不属于链接)。 */
const URL_RE = /https?:\/\/[^\s<>"'）)】」』，。；！？,;]+/g

/** 「1. 」「- 」「• 」「① 」这类列表前缀 —— 属于排版,不属于内容。 */
const BULLET_RE = /^\s*(?:[-*•]|\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/

const TITLE_MAX = 32

/**
 * 从一段文本里挑出短标题:第一个句读之前的部分,截断到 TITLE_MAX。
 * 什么都挑不出来(整段就是个链接)时回落到域名。
 */
export function deriveTitle(note: string, url: string | null): string {
  const stripped = note.replace(URL_RE, ' ').replace(BULLET_RE, '').trim()
  // 句读处断开;「——」「:」常被用来分隔「是什么」和「为什么」,也算断点。
  const head = stripped.split(/[。！？\n]|——|:|：/)[0]?.trim() ?? ''
  if (head.length > 0) return head.length > TITLE_MAX ? `${head.slice(0, TITLE_MAX)}…` : head
  if (url) {
    try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url.slice(0, TITLE_MAX) }
  }
  return '(无标题)'
}

/**
 * 把一次打猎发出的整段文本拆成猎物。
 *
 * 规则:**一个链接一条**。链接所在的那一段(段落优先,退回单行)就是它的
 * 正文。一条链接都没有时,整段作为一条无链接的猎物 —— 打猎不是每次都带
 * 链接回来,而「没有链接就当没打到」会静默丢掉真实的分享。
 */
export function parseCatch(text: string): CatchItem[] {
  const trimmed = text.trim()
  if (trimmed === '') return []

  // 先按空行分段;单段里若有多个链接,再按行拆。
  const blocks = trimmed.split(/\n\s*\n/).map(b => b.trim()).filter(b => b !== '')
  const units: string[] = []
  for (const b of blocks) {
    const urls = b.match(URL_RE) ?? []
    if (urls.length <= 1) { units.push(b); continue }
    // 一段里挤了多条 —— 按行拆开,不带链接的行并进**上一条**(它多半是
    // 那条的说明文字,单独成条会变成一堆无链接的碎片)。
    const lines = b.split('\n').map(l => l.trim()).filter(l => l !== '')
    for (const line of lines) {
      if (URL_RE.test(line) || units.length === 0) { URL_RE.lastIndex = 0; units.push(line) }
      else { units[units.length - 1] += `\n${line}` }
      URL_RE.lastIndex = 0
    }
  }

  // 开场白不是猎物。「今天两条：」这种起手式没有链接、排在所有真内容之前,
  // 留着的话每次打猎都往清单里攒一条垃圾行。
  //
  // 只砍**第一段**,而且只在后面确实有带链接的段落时砍 —— 「今天没找到
  // 链接,但那个团队昨天发了 1.0」是一条真分享,整段无链接时必须留下。
  // 后面出现的无链接段落也一律保留:静默丢掉真内容,比留一条垃圾行糟得多。
  const hasUrlAt = units.map(u => { URL_RE.lastIndex = 0; return URL_RE.test(u) })
  const body = hasUrlAt.length > 1 && !hasUrlAt[0] && hasUrlAt.slice(1).some(Boolean)
    ? units.slice(1)
    : units

  const items: CatchItem[] = []
  for (const unit of body) {
    const urls = unit.match(URL_RE) ?? []
    const url = urls[0] ?? null
    const note = unit.replace(BULLET_RE, '').trim()
    if (note === '') continue
    items.push({ title: deriveTitle(note, url), url, note })
  }
  return items
}
