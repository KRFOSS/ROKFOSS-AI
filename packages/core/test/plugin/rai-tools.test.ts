import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { RoomsRequestError, type Auth } from "@opencode/core/plugin/provider/rai-rooms"
import {
  callBody,
  callWithApproval,
  contentOf,
  describeTool,
  fetchTools,
  lastSseData,
  outcomeFromText,
  parametersOf,
  parseOutcome,
  parseTools,
  postCall,
  sameTools,
  serverName,
  toolID,
  toolsFailure,
  type Approval,
  type Outcome,
} from "@opencode/core/plugin/provider/rai-tools"

const auth: Auth = { endpoint: "https://gateway.example/api/rai/v1", key: "rai-test-key" }
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

function httpOf(handler: (input: { url: string; method: string; headers: Headers; body: string }) => Response) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = []
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
      const call = { url: web.url, method: web.method, headers: web.headers, body }
      calls.push(call)
      return HttpClientResponse.fromWeb(request, handler(call))
    }),
  )
  return { http, calls }
}

const result = (text: string, isError = false): Extract<Outcome, { type: "result" }> => ({
  type: "result",
  content: [{ type: "text", text }],
  isError,
})
const approval: Approval = { type: "approval", token: "tok-1", tool: "fastly_purge", title: "캐시 비우기" }

describe("RAI room tools: names and list", () => {
  test("prefixes contract names and refuses the rest", () => {
    expect(toolID("shell_run")).toBe("rai_shell_run")
    expect(toolID("Shell")).toBeUndefined()
    expect(toolID("1shell")).toBeUndefined()
    expect(toolID("shell-run")).toBeUndefined()
    expect(toolID("shell_edit_file")).toBe("rai_shell_edit_file")
    // `rai_` plus the name must fit the 64-character function name limit of model APIs.
    expect(toolID("a".repeat(60))).toBe(`rai_${"a".repeat(60)}`)
    expect(toolID("a".repeat(61))).toBeUndefined()
    expect(toolID("a".repeat(200))).toBeUndefined()
    expect(serverName(`rai_${"a".repeat(61)}`)).toBeUndefined()
    expect(serverName("rai_shell_run")).toBe("shell_run")
    expect(serverName("shell")).toBeUndefined()
  })

  test("parses the list, skipping bad and duplicate entries", () => {
    const listed = parseTools({
      object: "list",
      data: [
        {
          name: "shell_run",
          description: "명령 실행",
          parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          group: "terminal",
          approval: "never",
        },
        { name: "shell_run", description: "중복" },
        { name: "../etc", description: "나쁜 이름" },
        { name: "b".repeat(61), description: "너무 긴 이름" },
        { name: "fastly_purge", parameters: { type: "string" }, group: "fastly", approval: "ask" },
        "not an object",
      ],
    })
    const tools = listed?.tools
    expect(tools?.map((tool) => tool.name)).toEqual(["shell_run", "fastly_purge"])
    expect(listed?.skipped).toEqual(["../etc", "b".repeat(61)])
    expect(tools?.[0]?.parameters).toEqual({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    })
    expect(tools?.[1]?.parameters).toEqual({ type: "object", properties: {} })
    expect(tools?.[1]?.approval).toBe("ask")
    expect(parseTools({ object: "list" })).toBeUndefined()
    expect(parametersOf({ type: "object" })).toEqual({ type: "object", properties: {} })
  })

  test("describes tools for the model and compares lists", () => {
    const [tool] = parseTools({ data: [{ name: "search", description: "  찾기 " }] })?.tools ?? []
    expect(describeTool(tool!)).toBe("[RAI 대화방] 찾기")
    const [bare] = parseTools({ data: [{ name: "fetch" }] })?.tools ?? []
    expect(describeTool(bare!)).toBe("[RAI 대화방] fetch")
    expect(sameTools([tool!], [tool!])).toBe(true)
    expect(sameTools([tool!], [bare!])).toBe(false)
  })

  test("lists with the key and treats 401/403/404 as no tools", async () => {
    const ok = httpOf(() => Response.json({ object: "list", data: [{ name: "search" }] }))
    const tools = await run(fetchTools(ok.http, auth))
    expect(tools?.map((tool) => tool.name)).toEqual(["search"])
    expect(ok.calls[0]?.url).toBe("https://gateway.example/api/rai/v1/tools")
    expect(ok.calls[0]?.headers.get("authorization")).toBe("Bearer rai-test-key")
    expect(ok.calls[0]?.headers.get("user-agent")).toContain("ROKFOSS")

    const scope = httpOf(() =>
      Response.json({ error: { type: "permission", code: "scope_missing", message: "no" } }, { status: 403 }),
    )
    expect(await run(fetchTools(scope.http, auth))).toEqual([])
    const missing = httpOf(() => new Response("", { status: 404 }))
    expect(await run(fetchTools(missing.http, auth))).toEqual([])
    const down = httpOf(() => new Response("<html>", { status: 502 }))
    expect(await run(fetchTools(down.http, auth))).toBeUndefined()
  })
})

describe("RAI room tools: answers", () => {
  test("takes the last data event and skips pings", () => {
    expect(lastSseData(": ping\n\n: ping\n\ndata: {\"a\":1}\n\n")).toBe('{"a":1}')
    expect(lastSseData("data: first\n\n: ping\n\ndata: second\n\n")).toBe("second")
    expect(lastSseData("data: one\ndata: two\n\n")).toBe("one\ntwo")
    expect(lastSseData(": ping\r\n\r\ndata:{\"b\":2}\r\n\r\n")).toBe('{"b":2}')
    expect(lastSseData(": ping\n\n")).toBeUndefined()
    expect(lastSseData('{"object":"rai.tool_result"}')).toBeUndefined()
  })

  test("reads results, images, and errors", () => {
    const parsed = parseOutcome({
      object: "rai.tool_result",
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "iVBORw0KGgo=", mime_type: "image/png" },
        { type: "image", data: "AAAA", mime_type: "image/tiff" },
        { type: "audio", data: "AAAA" },
      ],
      is_error: false,
    })
    expect(parsed).toEqual({
      type: "result",
      content: [
        { type: "text", text: "hello" },
        { type: "file", uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" },
        { type: "text", text: "[그림]" },
      ],
      isError: false,
    })
    expect(parseOutcome({ object: "rai.tool_result", content: [], is_error: true })).toEqual({
      type: "result",
      content: [],
      isError: true,
    })
    const failed = parseOutcome({ error: { type: "conflict", code: "approval_invalid", message: "만료" } })
    expect(failed).toBeInstanceOf(RoomsRequestError)
    expect((failed as RoomsRequestError).code).toBe("approval_invalid")
    expect(parseOutcome("text")).toBeInstanceOf(RoomsRequestError)
    expect(contentOf(undefined)).toEqual([])
  })

  test("reads an approval request", () => {
    expect(
      parseOutcome({
        object: "rai.tool_approval",
        approval_token: "tok",
        tool: "fastly_purge",
        title: "캐시 비우기",
        purpose: "모든 캐시를 비웁니다",
        expires_in: 600,
      }),
    ).toEqual({
      type: "approval",
      token: "tok",
      tool: "fastly_purge",
      title: "캐시 비우기",
      purpose: "모든 캐시를 비웁니다",
      expiresIn: 600,
    })
    expect(parseOutcome({ object: "rai.tool_approval", tool: "x" })).toBeInstanceOf(RoomsRequestError)
    expect((parseOutcome({ object: "rai.tool_approval", approval_token: "t", tool: "x" }) as Approval).title).toBe(
      "x 실행 허가",
    )
  })

  test("reads SSE and plain JSON bodies alike", () => {
    const body = JSON.stringify({ object: "rai.tool_result", content: [{ type: "text", text: "ok" }] })
    expect(outcomeFromText(`: ping\n\ndata: ${body}\n\n`)).toEqual(result("ok"))
    expect(outcomeFromText(body)).toEqual(result("ok"))
    expect(outcomeFromText(": ping\n\n")).toBeInstanceOf(RoomsRequestError)
    expect(outcomeFromText("<html>")).toBeInstanceOf(RoomsRequestError)
  })

  test("names the tools scope when it is missing", () => {
    const failure = toolsFailure(
      403,
      JSON.stringify({ error: { type: "permission", code: "scope_missing", message: "scope" } }),
    )
    expect(failure.code).toBe("scope_missing")
    expect(failure.message).toContain("rooms_tools")
    expect(toolsFailure(404, JSON.stringify({ error: { code: "room_not_found", message: "없음" } })).code).toBe(
      "room_not_found",
    )
  })

  test("builds the call body with the token only when given", () => {
    expect(callBody("shell_run", { command: "ls" })).toEqual({ name: "shell_run", arguments: { command: "ls" } })
    expect(callBody("shell_run", undefined, "tok")).toEqual({
      name: "shell_run",
      arguments: {},
      approval_token: "tok",
    })
  })
})

describe("RAI room tools: approval flow", () => {
  test("returns a result without asking", async () => {
    const asked: Approval[] = []
    const out = await run(
      callWithApproval({
        call: () => Effect.succeed(result("done")),
        approve: (value) => Effect.sync(() => void asked.push(value)),
      }),
    )
    expect(out).toEqual(result("done"))
    expect(asked).toEqual([])
  })

  test("asks, then repeats the call with the token", async () => {
    const tokens: Array<string | undefined> = []
    const asked: Approval[] = []
    const out = await run(
      callWithApproval({
        call: (token) =>
          Effect.sync(() => {
            tokens.push(token)
            return token ? result("purged") : approval
          }),
        approve: (value) => Effect.sync(() => void asked.push(value)),
      }),
    )
    expect(out).toEqual(result("purged"))
    expect(tokens).toEqual([undefined, "tok-1"])
    expect(asked).toEqual([approval])
  })

  test("does not call again when the user refuses", async () => {
    const tokens: Array<string | undefined> = []
    const refused = await exit(
      callWithApproval<string>({
        call: (token) =>
          Effect.sync(() => {
            tokens.push(token)
            return approval as Outcome
          }),
        approve: () => Effect.fail("사용자가 거절했습니다"),
      }),
    )
    expect(Exit.isFailure(refused)).toBe(true)
    expect(tokens).toEqual([undefined])
  })

  test("starts over once on approval_invalid", async () => {
    const tokens: Array<string | undefined> = []
    let asked = 0
    const out = await run(
      callWithApproval({
        call: (token) => {
          tokens.push(token)
          if (!token) return Effect.succeed({ ...approval, token: `tok-${tokens.length}` } as Outcome)
          if (token === "tok-1")
            return Effect.fail(new RoomsRequestError("expired", { status: 409, code: "approval_invalid" }))
          return Effect.succeed(result("ok"))
        },
        approve: () => Effect.sync(() => void asked++),
      }),
    )
    expect(out).toEqual(result("ok"))
    expect(tokens).toEqual([undefined, "tok-1", undefined, "tok-3"])
    expect(asked).toBe(2)
  })

  test("gives up after the second approval_invalid", async () => {
    let calls = 0
    const failed = await exit(
      callWithApproval({
        call: (token) => {
          calls++
          return token
            ? Effect.fail(new RoomsRequestError("expired", { status: 409, code: "approval_invalid" }))
            : Effect.succeed(approval as Outcome)
        },
        approve: () => Effect.void,
      }),
    )
    expect(Exit.isFailure(failed)).toBe(true)
    expect(calls).toBe(4)
  })

  test("asks again when the server's plan changed after an approval, a bounded number of times", async () => {
    let asked = 0
    const changed: Outcome = { ...(approval as Outcome & { type: "approval" }), token: "second", title: "바뀐 계획" }
    const outcomes: Outcome[] = [approval as Outcome, changed, { type: "result", content: [], isError: false }]
    const tokens: Array<string | undefined> = []
    const done = await exit(
      callWithApproval({
        call: (token) => {
          tokens.push(token)
          return Effect.succeed(outcomes.shift() as Outcome)
        },
        approve: () => Effect.sync(() => void asked++),
      }),
    )
    expect(Exit.isSuccess(done)).toBe(true)
    expect(asked).toBe(2)
    expect(tokens).toEqual([undefined, (approval as { token: string }).token, "second"])
    const endless = await exit(
      callWithApproval({ call: () => Effect.succeed(approval as Outcome), approve: () => Effect.void }),
    )
    expect(Exit.isFailure(endless)).toBe(true)
  })

  test("keeps the server's details and preview apart from the model's purpose", () => {
    const parsed = parseOutcome({
      object: "rai.tool_approval",
      approval_token: "t",
      tool: "github_commit",
      title: "커밋",
      purpose: "모델이 쓴 목적",
      details: ["저장소 a/b", 3, "  "],
      preview: "+ 줄",
      expires_in: 600,
    })
    expect(parsed).toEqual({
      type: "approval",
      token: "t",
      tool: "github_commit",
      title: "커밋",
      purpose: "모델이 쓴 목적",
      details: ["저장소 a/b"],
      preview: "+ 줄",
      expiresIn: 600,
    })
  })
})

describe("RAI room tools: call over HTTP", () => {
  const url = "https://gateway.example/api/rai/v1/rooms/42/tools/call"

  test("posts the call as SSE and reads the last event", async () => {
    const body = JSON.stringify({ object: "rai.tool_result", content: [{ type: "text", text: "hi" }] })
    const fake = httpOf(
      () => new Response(`: ping\n\n: ping\n\ndata: ${body}\n\n`, { headers: { "content-type": "text/event-stream" } }),
    )
    const out = await run(postCall(fake.http, auth, url, callBody("shell_run", { command: "echo hi" })))
    expect(out).toEqual(result("hi"))
    const call = fake.calls[0]!
    expect(call.method).toBe("POST")
    expect(call.url).toBe(url)
    expect(call.headers.get("accept")).toBe("text/event-stream")
    expect(call.headers.get("authorization")).toBe("Bearer rai-test-key")
    expect(JSON.parse(call.body)).toEqual({ name: "shell_run", arguments: { command: "echo hi" } })
  })

  test("fails with the server's code", async () => {
    const fake = httpOf(() =>
      Response.json({ error: { type: "conflict", code: "approval_invalid", message: "만료" } }, { status: 409 }),
    )
    const failed = await exit(postCall(fake.http, auth, url, callBody("shell_run", {}, "tok")))
    expect(Exit.isFailure(failed)).toBe(true)
    if (Exit.isFailure(failed)) {
      const error = failed.cause.reasons.find((reason) => reason._tag === "Fail")
      expect(error && "error" in error ? (error.error as RoomsRequestError).code : undefined).toBe("approval_invalid")
    }
  })
})
