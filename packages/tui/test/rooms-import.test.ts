import { describe, expect, test } from "bun:test"
import { importedModel, newestRoomMessage, roomImport } from "../src/component/rooms-import"

const base = {
  sessionID: "ses_test",
  roomID: "42",
  title: "설계",
  agent: "build",
  projectID: "prj",
  directory: "/work",
  now: 1_000,
}

describe("방 대화를 세션으로 가져오기", () => {
  test("사용자 글과 답(추론 포함)을 순서대로 세션 메시지로 바꾼다", () => {
    const built = roomImport({
      ...base,
      model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
      messages: [
        { id: "1", role: "user", text: "질문", createdAt: "2026-11-17T00:00:00Z" },
        { id: "2", role: "assistant", text: "답", thinking: "먼저 따져 보면", provider: "codex", model: "gpt-5.5", createdAt: null },
        { id: "3", role: "tool", text: "검색", createdAt: null },
        { id: "4", role: "assistant", text: "", createdAt: null },
        { id: "5", role: "user", text: "   ", createdAt: null },
      ],
    })
    expect(built.info).toMatchObject({
      id: "ses_test",
      title: "설계",
      agent: "build",
      model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
      metadata: { rai: { roomID: "42" } },
      location: { directory: "/work" },
    })
    expect(built.messages).toHaveLength(2)
    const [user, answer] = built.messages as Array<Record<string, any>>
    expect(user).toMatchObject({ type: "user", text: "질문", time: { created: Date.parse("2026-11-17T00:00:00Z") } })
    expect(user?.id.startsWith("msg_")).toBe(true)
    expect(answer).toMatchObject({
      type: "assistant",
      agent: "build",
      model: { providerID: "rai", id: "codex/gpt-5.5" },
      content: [
        { type: "reasoning", text: "먼저 따져 보면" },
        { type: "text", text: "답" },
      ],
      time: { created: 1_000, completed: 1_000 },
      metadata: { rai: { roomID: "42", messageID: "2" } },
    })
    expect(String(answer?.id) > String(user?.id)).toBe(true)
  })

  test("모델 이름은 rai 공급자 아래 이름으로 붙인다", () => {
    expect(importedModel({ provider: "xai", model: "grok-4.3" })).toEqual({ providerID: "rai", id: "xai/grok-4.3" })
    expect(importedModel({ provider: "codex", model: "codex/gpt-5.5" })).toEqual({ providerID: "rai", id: "codex/gpt-5.5" })
    expect(importedModel({})).toEqual({ providerID: "rai", id: "unknown" })
  })

  test("따라잡기는 가져온 가장 새 메시지 뒤부터", () => {
    expect(newestRoomMessage([{ id: "9" }, { id: "12" }, { id: "m1" }])).toBe("12")
    expect(newestRoomMessage([])).toBe("0")
  })
})
