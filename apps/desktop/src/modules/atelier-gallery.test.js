import { describe, expect, it } from "vitest"
import { atelierEmptyState, atelierShareErrorLabel, buildAtelierShareRequest } from "./atelier-gallery.js"

describe("atelier share UI helpers", () => {
  it("builds reviewed-background and image-only requests", () => {
    expect(buildAtelierShareRequest("work-1", true, {
      title: " 潮线 ", origin: " 安静 ", approach: " 树枝 ",
    })).toEqual({
      id: "work-1",
      background: { title: "潮线", origin: "安静", approach: "树枝" },
    })
    expect(buildAtelierShareRequest("work-1", false, {
      title: "ignored", origin: "ignored", approach: "ignored",
    })).toEqual({ id: "work-1", background: null })
  })

  it("turns expected transport states into useful recovery copy", () => {
    expect(atelierShareErrorLabel(new Error("owner_chat_not_configured"))).toContain("默认微信会话")
    expect(atelierShareErrorLabel(new Error("sendmessage errcode=-2: prepare failed"))).toContain("先给 CC 发条消息")
    expect(atelierShareErrorLabel(new Error("network down"))).toContain("仍安全地留在画室")
  })
})

describe("atelier empty states", () => {
  it("does not mistake cached ready status for an enabled atelier", () => {
    expect(atelierEmptyState({mode: "off", status: {state: "ready"}}).title).toBe("画室尚未开启")
  })
  it("distinguishes preparation, failure, readiness and unavailable service", () => {
    expect(atelierEmptyState({mode: "private", status: {state: "downloading"}}).title).toBe("正在准备画笔")
    expect(atelierEmptyState({mode: "private", status: {state: "failed"}}).title).toBe("画笔暂时没准备好")
    expect(atelierEmptyState({mode: "private", status: {state: "ready"}}).title).toBe("画笔就绪，等待第一幅作品")
    expect(atelierEmptyState(null).action).toBe("retry")
    expect(atelierEmptyState({status: null}).detail).toContain("无法确认")
  })
})
