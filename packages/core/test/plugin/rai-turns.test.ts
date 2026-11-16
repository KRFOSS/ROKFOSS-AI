import { describe, expect, test } from "bun:test"
import {
  activeTurn,
  appendText,
  appendThinking,
  drain,
  finalContent,
  markTool,
  parseTurnDone,
  parseTurnEvents,
  parseTurnStart,
  promptStartsTurn,
  relayable,
  settleText,
  startRefusal,
  toolMark,
  turnDoneBody,
  turnEventBody,
  turnStartBody,
  turnURLs,
} from "../../src/plugin/provider/rai-turns.js"

const endpoint = "https://project.krfoss.org/api/rai/v1"
const turnID = "9f3a6c1e2b7d48a0b5e1c4d7f20a8e63"

describe("중계 대상", () => {
  // The gateway cannot call a free OpenCode model, so the local answer has to be recorded through this window.
  test("무료 오픈코드 모델을 포함한 로컬 응답은 중계한다", () => {
    expect(relayable("opencode")).toBe(true)
    expect(relayable("opencode-go")).toBe(true)
    expect(relayable("anthropic")).toBe(true)
    expect(relayable(undefined)).toBe(true)
    expect(relayable("opencode")).toBe(true)
  })

  // A RAI model is answered by the gateway, which records the reply itself; relaying it would duplicate it.
  test("RAI 응답은 중계하지 않는다", () => {
    expect(relayable("rai")).toBe(false)
    expect(relayable("RAI")).toBe(false)
    expect(relayable(" rai ")).toBe(false)
  })
})

describe("입력이 새 회차인지", () => {
  // 모든 입력의 기본 전달 방식이 steer 라서, steer 를 끼어들기로 보면 어떤 회차도 기록되지 않는다
  test("회차가 없을 때의 입력은 전달 방식과 상관없이 새 회차다", () => {
    expect(promptStartsTurn("steer", false)).toBe(true)
    expect(promptStartsTurn(undefined, false)).toBe(true)
    expect(promptStartsTurn("queue", false)).toBe(true)
  })

  test("기록 중인 회차가 있으면 끼어들기는 그 회차에 속하고 대기열 입력만 다음 회차다", () => {
    expect(promptStartsTurn("steer", true)).toBe(false)
    expect(promptStartsTurn(undefined, true)).toBe(false)
    expect(promptStartsTurn("queue", true)).toBe(true)
  })
})

describe("외부 응답 회차 본문", () => {
  test("메시지·모델·공급자만 보낸다", () => {
    const body = turnStartBody({ message: "README 를 요약해 줘", model: "kimi-k2", provider: "opencode" })
    expect(body).toEqual({ ok: true, body: { message: "README 를 요약해 줘", model: "kimi-k2", provider: "opencode" } })
  })

  test("빈 메시지와 잘못된 모델 이름은 거절한다", () => {
    expect(turnStartBody({ message: "   ", model: "kimi-k2" }).ok).toBe(false)
    expect(turnStartBody({ message: "안녕", model: "" }).ok).toBe(false)
    const long = "m".repeat(201)
    expect(turnStartBody({ message: "안녕", model: long }).ok).toBe(false)
    expect(turnStartBody({ message: "안녕", model: "a\nb" }).ok).toBe(false)
    // Spec 3.7: no whitespace and ASCII only.
    expect(turnStartBody({ message: "안녕", model: "kimi k2" }).ok).toBe(false)
    expect(turnStartBody({ message: "안녕", model: "키미-k2" }).ok).toBe(false)
    expect(turnStartBody({ message: "안녕", model: "opencode/opencode-go/glm-5" }).ok).toBe(true)
  })

  test("공급자는 소문자로 맞추고 형식이 틀리면 거절한다", () => {
    // The gateway records a lowercase provider id; a client-side spelling is normalized instead of rejected.
    expect(turnStartBody({ message: "안녕", model: "kimi-k2", provider: "OpenCode" })).toEqual({
      ok: true,
      body: { message: "안녕", model: "kimi-k2", provider: "opencode" },
    })
    expect(turnStartBody({ message: "안녕", model: "kimi-k2", provider: "open code" })).toEqual({
      ok: false,
      error: "공급자 이름이 올바르지 않습니다",
    })
    expect(turnStartBody({ message: "안녕", model: "kimi-k2", provider: "x".repeat(65) }).ok).toBe(false)
  })
})

describe("도구 표시는 비밀을 싣지 않는다", () => {
  test("도구 이름만 보낸다", () => {
    expect(toolMark("read", "start")).toEqual({ name: "read", state: "start" })
    expect(toolMark("bash", "end")).toEqual({ name: "bash", state: "end" })
  })

  // An argument would arrive as `bash(rm -rf /)`, and a path or a token must never leave the process.
  test("인자·경로가 붙은 이름은 버린다", () => {
    expect(toolMark("bash(rm -rf /)", "start")).toBeUndefined()
    expect(toolMark("read /etc/passwd", "start")).toBeUndefined()
    expect(toolMark("", "start")).toBeUndefined()
    expect(toolMark("m".repeat(65), "start")).toBeUndefined()
  })
})

describe("이벤트 본문", () => {
  test("빈 본문은 살아 있음 신호다", () => {
    expect(turnEventBody({})).toEqual({})
  })

  test("조각과 도구 표시를 담는다", () => {
    expect(turnEventBody({ delta: "README 는 " })).toEqual({ delta: "README 는 " })
    expect(turnEventBody({ thinking: "생각" })).toEqual({ thinking: "생각" })
    expect(turnEventBody({ tool: { name: "read", state: "start" } })).toEqual({
      tool: { name: "read", state: "start" },
    })
  })

  test("한 요청의 상한을 넘는 조각은 자른다", () => {
    const body = turnEventBody({ delta: "가".repeat(80_000) })
    expect(String(body.delta).length).toBe(64_000)
  })
})

describe("회차 시작 응답", () => {
  test("32자 16진수 turn_id 만 받는다", () => {
    expect(parseTurnStart({ turn_id: turnID, user_message_id: 4520, heartbeat_seconds: 15 })).toEqual({
      turnID,
      userMessageID: 4520,
      heartbeatSeconds: 15,
    })
    expect(parseTurnStart({ turn_id: "../../etc/passwd" })).toBeUndefined()
    expect(parseTurnStart({ turn_id: "ABC" })).toBeUndefined()
    expect(parseTurnStart({})).toBeUndefined()
    expect(parseTurnStart(undefined)).toBeUndefined()
  })
})

describe("회차 이벤트 응답", () => {
  test("정지와 끼어든 지시를 읽는다", () => {
    const reply = parseTurnEvents({ stop: true, steers: [{ message_id: 4523, text: "표로 정리해 줘" }] })
    expect(reply.stop).toBe(true)
    expect(reply.steers).toHaveLength(1)
    expect(reply.steers[0]?.text).toBe("표로 정리해 줘")
    expect(reply.steers[0]?.messageID).toBe(4523)
  })

  test("빈 응답은 아무것도 뜻하지 않는다", () => {
    expect(parseTurnEvents({})).toEqual({ stop: false, steers: [] })
    expect(parseTurnEvents(undefined)).toEqual({ stop: false, steers: [] })
    expect(parseTurnEvents({ steers: [{ text: "   " }] }).steers).toEqual([])
  })
})

describe("회차 끝 응답", () => {
  test("저장된 답 번호를 읽는다", () => {
    expect(parseTurnDone({ assistant_message_id: 4524 })).toEqual({ assistantMessageID: 4524 })
    expect(parseTurnDone({ assistant_message_id: 0 })).toEqual({ assistantMessageID: undefined })
  })

  test("답 본문과 정지·오류를 담는다", () => {
    expect(turnDoneBody({ content: "요약입니다", model: "kimi-k2", stopped: true })).toEqual({
      content: "요약입니다",
      model: "kimi-k2",
      stopped: true,
    })
    const withError = turnDoneBody({ content: "", error: "생성이 실패했습니다" })
    expect(withError.error).toBe("생성이 실패했습니다")
    expect(turnDoneBody({ content: "x", error: "e".repeat(3_000) }).error).toHaveLength(2_000)
  })
})

describe("경로는 검증한 값으로만 만든다", () => {
  test("대화방·회차 번호로 경로를 만든다", () => {
    const urls = turnURLs(endpoint, "123", turnID)
    expect(urls?.start).toBe(`${endpoint}/rooms/123/turns`)
    expect(urls?.events).toBe(`${endpoint}/rooms/123/turns/${turnID}/events`)
    expect(urls?.done).toBe(`${endpoint}/rooms/123/turns/${turnID}/done`)
  })

  // The key rides on every request, so a traversing id must never reach a URL.
  test("회차·대화방 번호가 이상하면 경로를 만들지 않는다", () => {
    expect(turnURLs(endpoint, "123", "../evil")).toBeUndefined()
    expect(turnURLs(endpoint, "1/../../x", turnID)).toBeUndefined()
    expect(turnURLs("http://project.krfoss.org/api/rai/v1", "123", turnID)).toBeUndefined()
  })
})

describe("회차 내용 조립", () => {
  const turn = () =>
    activeTurn({ sessionID: "ses_1", roomID: "123", turnID, model: "kimi-k2", provider: "opencode" })

  test("조각을 이어 붙이고 한 번에 묶어 보낸다", () => {
    const state = turn()
    appendText(state, "m1:0", "README 는 ")
    appendText(state, "m1:0", "설치와 사용법을 ")
    const first = drain(state)
    expect(first).toEqual({ delta: "README 는 설치와 사용법을 " })
    expect(drain(state)).toBeUndefined()
    expect(finalContent(state)).toBe("README 는 설치와 사용법을 ")
  })

  test("도구 표시는 글과 섞이지 않고 차례를 지킨다", () => {
    const state = turn()
    appendText(state, "m1:0", "앞")
    markTool(state, { name: "read", state: "start" })
    appendText(state, "m1:0", "뒤")
    expect(drain(state)).toEqual({ delta: "앞" })
    expect(drain(state)).toEqual({ tool: { name: "read", state: "start" } })
    expect(drain(state)).toEqual({ delta: "뒤" })
  })

  test("끝난 조각은 누적본으로 대체한다", () => {
    const state = turn()
    appendText(state, "m1:0", "잘린 ")
    settleText(state, "m1:0", "완전한 문장")
    expect(finalContent(state)).toBe("완전한 문장")
  })

  test("여러 단계의 글을 순서대로 모은다", () => {
    const state = turn()
    appendText(state, "m1:0", "첫째 ")
    appendText(state, "m1:1", "둘째")
    expect(finalContent(state)).toBe("첫째 둘째")
  })

  test("추론 글은 답 본문에 들어가지 않는다", () => {
    const state = turn()
    appendThinking(state, "생각 중")
    appendText(state, "m1:0", "답")
    drain(state)
    drain(state)
    expect(finalContent(state)).toBe("답")
  })
})

describe("회차 시작 거절", () => {
  // Spec 3.7: a room this window can never record into is unbound; a refusal that may pass keeps the binding.
  test("영구 거절은 묶기를 푼다", () => {
    expect(startRefusal(403, "room_read_only")).toBe("unbind")
    expect(startRefusal(400, "plugin_external_room")).toBe("unbind")
    expect(startRefusal(403, "project_share_required")).toBe("unbind")
    expect(startRefusal(404, undefined)).toBe("unbind")
  })

  test("잠시 거절은 묶기를 남기고 알리기만 한다", () => {
    expect(startRefusal(409, "room_busy")).toBe("notice")
    expect(startRefusal(409, "mcp_room_active")).toBe("notice")
    expect(startRefusal(409, "project_transfer_busy")).toBe("notice")
    expect(startRefusal(503, "server_draining")).toBe("notice")
  })

  test("키 문제는 따로 안내한다", () => {
    expect(startRefusal(403, "scope_missing")).toBe("key")
    expect(startRefusal(401, "expired_api_key")).toBe("key")
    expect(startRefusal(403, undefined)).toBe("key")
  })

  test("모르는 실패는 기록 없이 로컬 답을 계속한다", () => {
    expect(startRefusal(502, "upstream_error")).toBe("silent")
    expect(startRefusal(undefined, undefined)).toBe("silent")
  })

  test("spec 3.7 이 이름한 거절에는 모두 안내 문구가 있다", () => {
    for (const code of [
      "room_busy",
      "room_read_only",
      "mcp_room_active",
      "project_transfer_busy",
      "server_draining",
      "plugin_external_room",
      "project_share_required",
      "turn_closed",
      "turn_not_found",
      "invalid_provider",
      "invalid_model",
      "invalid_tool",
      "error_too_long",
      "request_too_large",
    ])
      expect(startRefusal(400, code), code).not.toBe("silent")
  })
})
