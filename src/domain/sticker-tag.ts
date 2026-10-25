/**
 * 表情 tag 的比法(trim + 不分大小写)—— 纯规则。表情库(src/features/stickers)数「本地这个心情够不够」、
 * 回复附件(internal-api 的 /v1/turn/attach)攒表情前看库里有没有这个 tag,都用这一份;
 * 表情库挑图的 resolve 用的是同一种比法。
 */
export function countForTag(entries: ReadonlyArray<{ tags: readonly string[] }>, tag: string): number {
  const target = tag.trim().toLowerCase()
  return entries.filter((entry) => entry.tags.some((item) => item.trim().toLowerCase() === target)).length
}
