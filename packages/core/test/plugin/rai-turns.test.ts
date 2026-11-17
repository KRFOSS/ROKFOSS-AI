import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import {
  activeTurn,
  appendText,
  appendThinking,
  authorOf,
  drain,
  finalContent,
  markTool,
  messagesAfter,
  mirrorModel,
  parseTurnDone,
  parseTurnEvents,
  parseTurnStart,
  promptStartsTurn,
  relayable,
  settleText,
  startRefusal,
  startTurns,
  storedToMirror,
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

  // A RAI model only lends its model through /responses, which keeps no room, so its answer is relayed as well.
  test("RAI 모델로 이 컴퓨터가 만든 답도 중계한다", () => {
    expect(relayable("rai")).toBe(true)
    expect(relayable("RAI")).toBe(true)
  })
})

describe("웹에서 온 글 따라잡기", () => {
  test("마지막으로 맞춘 번호 뒤의 메시지만 오래된 순서로 고른다", () => {
    const messages = [{ id: "12" }, { id: "9" }, { id: "10" }, { id: "m3" }, { id: "11" }]
    expect(messagesAfter(messages, "10").map((m) => m.id)).toEqual(["11", "12"])
    expect(messagesAfter(messages, null).map((m) => m.id)).toEqual(["9", "10", "11", "12"])
    expect(messagesAfter(messages, "12")).toEqual([])
  })

  test("비춘 답에는 이 세션이 고를 수 있는 RAI 모델 이름을 단다", () => {
    expect(mirrorModel("codex", "gpt-5.5")).toEqual({ providerID: "rai", id: "codex/gpt-5.5" })
    expect(mirrorModel(undefined, "opencode/glm-5")).toEqual({ providerID: "rai", id: "opencode/glm-5" })
    expect(mirrorModel("codex", null)).toEqual({ providerID: "rai", id: "unknown" })
  })

  // 공유받은 방에서 남이 쓴 글만 이름을 단다. 내 글은 내가 친 것처럼 보인다.
  test("남이 쓴 사용자 글에만 이름을 붙인다", () => {
    expect(authorOf({ role: "user", author: "앨리스", mine: false })).toBe("앨리스")
    expect(authorOf({ role: "user", author: "나", mine: true })).toBeUndefined()
    expect(authorOf({ role: "user", author: "모름" })).toBeUndefined()
    expect(authorOf({ role: "assistant", author: "앨리스", mine: false })).toBeUndefined()
  })

  test("실시간으로 비춘 답의 저장본은 한 번만 건너뛴다", () => {
    const messages = [
      { id: "5", role: "assistant" },
      { id: "6", role: "user" },
      { id: "7", role: "assistant" },
    ]
    expect(storedToMirror(messages, true).map((item) => item.mirror)).toEqual([false, true, true])
    expect(storedToMirror(messages, false).map((item) => item.mirror)).toEqual([true, true, true])
    // A user line first means the live answer was never saved; nothing after it is skipped.
    expect(storedToMirror([{ id: "6", role: "user" }, { id: "7", role: "assistant" }], true).map((item) => item.mirror)).toEqual([true, true])
    expect(storedToMirror([{ id: "8", role: "tool" }], false).map((item) => item.mirror)).toEqual([false])
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

function httpOf(handler: (url: string) => Response) {
  const urls: string[] = []
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      urls.push(web.url)
      return HttpClientResponse.fromWeb(request, handler(web.url))
    }),
  )
  return { http, urls }
}

function mirrorHost(sessionID: string, lastMessageID: string) {
  const storage = new Map<string, unknown>([[`rai-turn/${sessionID}`, { roomID: "7", title: "방", lastMessageID }]])
  const calls: Array<Record<string, unknown>> = []
  const hooks: Array<(event: unknown) => Effect.Effect<void>> = []
  let next = 0
  const ctx = {
    storage: {
      get: (key: string) => Effect.succeed(storage.get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => void storage.set(key, value)),
      remove: (key: string) => Effect.sync(() => void storage.delete(key)),
    },
    session: {
      hook: (_name: string, callback: (event: unknown) => Effect.Effect<void>) => Effect.sync(() => void hooks.push(callback)),
      mirror: {
        user: (request: { text: string; author?: string }) =>
          Effect.sync(() => {
            calls.push({ kind: "user", text: request.text, author: request.author })
            return `msg_${next++}`
          }),
        answer: (request: { model: unknown }) =>
          Effect.sync(() => {
            calls.push({ kind: "answer", model: request.model })
            return {
              messageID: `msg_${next++}`,
              text: (delta: string) => Effect.sync(() => void calls.push({ kind: "text", delta })),
              reasoning: (delta: string) => Effect.sync(() => void calls.push({ kind: "reasoning", delta })),
              end: (end?: Record<string, unknown>) => Effect.sync(() => void calls.push({ kind: "end", ...end })),
            }
          }),
      },
    },
    event: { subscribe: () => Stream.never },
    integration: {
      connection: {
        active: () => Effect.succeed({ type: "credential", id: "rai" }),
        resolve: () => Effect.succeed({ type: "key", key: "rai-test-key" }),
      },
    },
  }
  const last = () => (storage.get(`rai-turn/${sessionID}`) as { lastMessageID?: string } | undefined)?.lastMessageID
  return { ctx, calls, hooks, last }
}

const until = (check: () => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out"))
      yield* Effect.sleep("5 millis")
    }
  })

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

describe("웹에서 온 글을 세션에 비추기", () => {
  test("웹 글과 저장된 답을 사용자·어시스턴트 메시지로 비추고 번호를 넘긴다", async () => {
    const sessionID = "ses_mirror_stored"
    const host = mirrorHost(sessionID, "0")
    const { http, urls } = httpOf(() =>
      Response.json({
        room: { id: 7, title: "방" },
        messages: [
          { id: 1, role: "user", content: "질문", author: { id: 1, name: "나" }, mine: true },
          { id: 2, role: "assistant", content: "답", thinking: "따져 보면", provider: "codex", model: "gpt-5.5" },
          { id: 3, role: "user", content: "덧붙임", author: { id: 2, name: "앨리스" }, mine: false },
        ],
      }),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handlers = yield* startTurns(host.ctx as never, http)
          expect(yield* handlers.sync({ sessionID })).toEqual({ added: 3, error: null })
          yield* until(() => host.last() === "3")
          expect(yield* handlers.sync({ sessionID })).toEqual({ added: 0, error: null })
        }),
      ),
    )
    expect(host.calls).toEqual([
      { kind: "user", text: "질문", author: undefined },
      { kind: "answer", model: { providerID: "rai", id: "codex/gpt-5.5" } },
      { kind: "end", text: "답", reasoning: "따져 보면" },
      { kind: "user", text: "덧붙임", author: "앨리스" },
    ])
    expect(urls.some((url) => url.includes("/stream"))).toBe(false)
  })

  test("방이 만드는 답은 조각마다 흘려 넣고 저장본으로 마무리한다", async () => {
    const sessionID = "ses_mirror_live"
    const host = mirrorHost(sessionID, "0")
    const room = { id: 7, title: "방", provider: "codex", model: "gpt-5.5" }
    const reads = { count: 0 }
    const { http } = httpOf((url) => {
      if (url.endsWith("/rooms/7/stream"))
        return sse([{ thinking: "생각 " }, { delta: "안" }, { delta: "녕" }, { done: true }])
      reads.count++
      if (reads.count === 1) return Response.json({ room, running: true, messages: [{ id: 1, role: "user", content: "질문" }] })
      return Response.json({
        room,
        messages: [
          { id: 1, role: "user", content: "질문" },
          { id: 2, role: "assistant", content: "안녕!", thinking: "생각 전체", provider: "codex", model: "gpt-5.5" },
        ],
      })
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handlers = yield* startTurns(host.ctx as never, http)
          // Two calls at once: only one catch-up runs, so the line and the answer are shown once.
          const results = yield* Effect.all([handlers.sync({ sessionID }), handlers.sync({ sessionID })], {
            concurrency: "unbounded",
          })
          expect(results.map((result) => result.added).toSorted()).toEqual([0, 1])
          yield* until(() => host.last() === "2")
        }),
      ),
    )
    expect(host.calls).toEqual([
      { kind: "user", text: "질문", author: undefined },
      { kind: "answer", model: { providerID: "rai", id: "codex/gpt-5.5" } },
      { kind: "reasoning", delta: "생각 " },
      { kind: "text", delta: "안" },
      { kind: "text", delta: "녕" },
      { kind: "end", text: "안녕!", reasoning: "생각 전체" },
    ])
  })

  test("세션이 자기 회차를 시작하려 하면 방을 읽지 않는다", async () => {
    const sessionID = "ses_mirror_own"
    const host = mirrorHost(sessionID, "0")
    const { http, urls } = httpOf(() => Response.json({ messages: [{ id: 1, role: "user", content: "웹 글" }] }))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handlers = yield* startTurns(host.ctx as never, http)
          for (const hook of host.hooks) yield* hook({ sessionID, delivery: undefined, prompt: { text: "로컬 질문" } })
          expect(yield* handlers.sync({ sessionID })).toEqual({ added: 0, error: null })
        }),
      ),
    )
    expect(urls).toEqual([])
    expect(host.calls).toEqual([])
  })
})
