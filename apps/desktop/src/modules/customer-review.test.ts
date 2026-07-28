import { describe, expect, it, vi, beforeEach } from "vitest"
import { defaultReviewRange, orderReviewItems, reviewFailureCopy, reviewProgressCopy } from "./customer-review-utils.js"

// The module graph (api.js → ipc.js) reads window.__TAURI__ at import time,
// so these must exist BEFORE the dynamic import below, not in beforeEach.
// @ts-expect-error minimal stub
globalThis.window = { __TAURI__: undefined, addEventListener: () => {} }
// @ts-expect-error minimal stub
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] }

const { safeError } = await import("./customer-review.js")

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("safeError", () => {
  it("names the missing wxvault plugin instead of saying 'try again later'", async () => {
    // The default state for most installs. "稍后再试" was a lie: waiting never
    // fixes a plugin that was never installed, and nothing else on screen or
    // in devtools said what was wrong.
    const copy = safeError(new Error("WXVAULT_ERROR: wxvault tool list_conversations is unavailable"))
    expect(copy).toMatch(/wxvault/)
    expect(copy).toMatch(/插件/)
    expect(copy).not.toMatch(/稍后再试/)
  })

  it("distinguishes 'not wired yet' from 'plugin missing'", () => {
    expect(safeError(new Error("customer_review_not_wired"))).toMatch(/重启/)
  })

  it("passes the range-too-large guidance through verbatim", () => {
    // The daemon already phrases this one for the owner ("请把时间范围缩小一些").
    const msg = "这段时间里的消息超过 20000 条，请把时间范围缩小一些再回顾"
    expect(safeError(new Error(msg))).toBe(msg)
  })

  it("still logs the raw error so a broken install leaves a trace", () => {
    safeError(new Error("boom"))
    expect(console.warn).toHaveBeenCalledWith("[customer-review]", "boom")
  })

  it("falls back to generic copy for anything unrecognised", () => {
    expect(safeError(new Error("HTTP 500"))).toBe("操作没有完成，请稍后再试。")
  })
})

describe("defaultReviewRange", () => {
  it("defaults to the most recent three calendar months", () => {
    expect(defaultReviewRange(new Date(2026, 6, 15, 23, 30))).toEqual({
      from: "2026-04-15",
      to: "2026-07-15",
    })
  })

  it("clamps month-end dates instead of overflowing into the next month", () => {
    expect(defaultReviewRange(new Date(2026, 4, 31))).toEqual({
      from: "2026-02-28",
      to: "2026-05-31",
    })
  })
})

describe("orderReviewItems", () => {
  it("keeps open commitments before completed items without mutating input", () => {
    const input = [
      { sourceKey: "b", aiStatus: "completed" as const },
      { sourceKey: "a", aiStatus: "open" as const },
    ]
    const output = orderReviewItems(input)
    expect(output.map(item => item.sourceKey)).toEqual(["a", "b"])
    expect(input.map(item => item.sourceKey)).toEqual(["b", "a"])
  })
})

describe("reviewFailureCopy", () => {
  it("explains withheld AI output as a reliability safeguard", () => {
    expect(reviewFailureCopy("AI_INVALID_AI_OUTPUT")).toMatchObject({
      title: "这次没有生成可核对的结果",
      body: expect.stringContaining("误判"),
      hint: expect.stringContaining("缩短时间范围"),
    })
  })

  it("gives a different action for an oversized analysis range", () => {
    expect(reviewFailureCopy("AI_TOO_MANY_OPEN_COMMITMENTS")).toMatchObject({
      title: "这段沟通范围有些大",
      hint: expect.stringContaining("缩短时间范围"),
    })
  })
})

describe("reviewProgressCopy", () => {
  it("shows elapsed time and a range instead of a false exact ETA", () => {
    expect(reviewProgressCopy("analyzing", "2026-07-15T10:00:00.000Z", Date.parse("2026-07-15T10:00:32.000Z"))).toEqual({
      kicker: "正在分析",
      detail: "已等待 32 秒 · 通常需要 20–60 秒。",
    })
  })

  it("sets a longer expectation only after a minute", () => {
    expect(reviewProgressCopy("analyzing", "2026-07-15T10:00:00.000Z", Date.parse("2026-07-15T10:01:05.000Z")).detail)
      .toBe("已等待 1 分 5 秒 · 较长的沟通范围可能需要 1–2 分钟。")
  })
})
