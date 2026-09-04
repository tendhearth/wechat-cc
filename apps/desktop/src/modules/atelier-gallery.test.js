import { describe, expect, it } from "vitest"
import { atelierShareErrorLabel, buildAtelierShareRequest } from "./atelier-gallery.js"

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
