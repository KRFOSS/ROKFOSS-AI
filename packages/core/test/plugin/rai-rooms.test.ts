import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { RaiRooms } from "@opencode/schema/rai-rooms"
import {
  chatBody,
  connectFirst,
  createBody,
  createRoom,
  defaultBaseURL,
  keyOf,
  listProjects,
  messagesURL,
  pageLimit,
  parsePage,
  parseRooms,
  failureFrom,
  pickEndpoint,
  postChat,
  pushSse,
  readMessages,
  registerRooms,
  requestURL,
  roomSegment,
  roomsMessage,
  watchRoom,
  type Auth,
} from "@opencode/core/plugin/provider/rai-rooms"
import { describe as describeFailure } from "@opencode/core/plugin/provider/rai"

const key = `rai-${"a".repeat(43)}`
const auth: Auth = { endpoint: defaultBaseURL, key }
const sendInput = {
  roomID: "room-1",
  provider: "xai" as const,
  model: "grok-4.3",
  message: "이어서",
  effort: null,
  projectID: null,
  credentialOwnerID: null,
  search: false,
  audience: null,
}

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)

/**
 * `rpc.register` acquires a scope once the mock stands in for the real RPC layer, so registration is scoped
 * here and `run` keeps its plain no-requirement signature.
 */
const register = (ctx: unknown, http: HttpClient.HttpClient) => Effect.scoped(registerRooms(ctx as never, http))

function httpOf(handler: (input: { url: string; headers: Headers; body: string; signal: AbortSignal }) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Headers; body: string }> = []
  const http = HttpClient.make((request, _url, signal) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      const body = yield* request.body._tag === "Uint8Array"
        ? Effect.succeed(new TextDecoder().decode(request.body.body))
        : Effect.succeed("")
      calls.push({ url: web.url, headers: web.headers, body })
      const response = yield* Effect.promise(() => Promise.resolve(handler({ url: web.url, headers: web.headers, body, signal })))
      return HttpClientResponse.fromWeb(request, response)
    }),
  )
  return { http, calls }
}

describe("RAI rooms protocol", () => {
  test("keeps the key on the gateway and refuses a project host or cleartext", () => {
    expect(pickEndpoint({})).toBe(defaultBaseURL)
    expect(pickEndpoint({ env: "http://project.krfoss.org/api/rai/v1" })).toBe(defaultBaseURL)
    expect(pickEndpoint({ project: "https://evil.example/steal" })).toBe(defaultBaseURL)
    expect(pickEndpoint({ project: "https://project.krfoss.org:8443/api/rai/v1" })).toBe(defaultBaseURL)
    expect(pickEndpoint({ user: "https://project.krfoss.org/custom/v1" })).toBe("https://project.krfoss.org/custom/v1")
    expect(pickEndpoint({ env: "https://lab.example/rai", project: "https://evil.example" })).toBe("https://lab.example/rai")
  })

  test("refuses a room id that would escape the rooms path", () => {
    expect(roomSegment("../responses")).toBeUndefined()
    expect(roomSegment("rooms/../responses")).toBeUndefined()
    expect(roomSegment("..")).toBeUndefined()
    expect(roomSegment("")).toBeUndefined()
    expect(roomSegment("0")).toBeUndefined()
    expect(roomSegment("room-1")).toBe("room-1")
    expect(requestURL(defaultBaseURL, "/rooms/../responses")).toBeUndefined()
    expect(requestURL("http://project.krfoss.org/api/rai/v1", "/rooms")).toBeUndefined()
    expect(requestURL(defaultBaseURL, "/rooms/room-1")).toBe(`${defaultBaseURL}/rooms/room-1`)
    expect(messagesURL(defaultBaseURL, "../responses", 20)).toBeUndefined()
    expect(messagesURL(defaultBaseURL, "room-1", 20, "msg-9")).toBe(
      `${defaultBaseURL}/rooms/room-1?limit=20&before=msg-9`,
    )
    expect(pageLimit(10_000)).toBe(100)
  })

  test("builds a continuation body with only the room contract fields", () => {
    const built = chatBody({ ...sendInput, roomID: "0", projectID: "proj-1", effort: "low", search: true, credentialOwnerID: 4 })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.body).toEqual({
      room_id: 0,
      provider: "xai",
      model: "grok-4.3",
      message: "이어서",
      project_id: "proj-1",
      effort: "low",
      search: true,
      credential_owner_id: 4,
    })
    expect(built.body).not.toHaveProperty("store")
    expect(built.body).not.toHaveProperty("previous_response_id")
    expect(built.body).not.toHaveProperty("input")
    expect(built.body).not.toHaveProperty("tools")
    expect(built.body).not.toHaveProperty("include")
    expect(chatBody({ ...sendInput, provider: "openai" }).ok).toBe(false)
    expect(chatBody({ ...sendInput, roomID: "../responses" }).ok).toBe(false)
  })

  test("sends search false so a missing field cannot turn the gateway default on", () => {
    const off = chatBody(sendInput)
    const omitted = chatBody({ ...sendInput, search: undefined })
    const on = chatBody({ ...sendInput, search: true })
    expect(off.ok && off.body.search).toBe(false)
    expect(omitted.ok && omitted.body.search).toBe(false)
    expect(on.ok && on.body.search).toBe(true)
    expect(Object.keys(RaiRooms.Definition.events)).toEqual([])
  })

  test("ignores SSE comments and does not keep thinking text or tool arguments", () => {
    const fixture = [
      ": ping",
      "",
      'data: {"room_id":"room-9","delta":"안"}',
      "",
      'data: {"thinking":"secret chain of thought"}',
      "",
      'data: {"tool":{"name":"shell","arguments":{"cmd":"rm -rf /"}},"label":"shell"}',
      "",
      'data: {"tool_done":true,"ok":false}',
      "",
      'data: {"error":"업스트림 오류"}',
      "",
      'data: {"done":true}',
      "",
      "",
    ].join("\n")
    const pulled = pushSse("", fixture)
    expect(pulled.frames.map((frame) => frame.kind)).toEqual(["delta", "thinking", "tool", "tool_done", "error", "done"])
    expect(pulled.frames.find((frame) => frame.kind === "thinking")).toEqual({ kind: "thinking", roomID: undefined })
    expect(JSON.stringify(pulled.frames)).not.toContain("secret chain")
    expect(JSON.stringify(pulled.frames)).not.toContain("rm -rf")
    expect(pulled.frames.find((frame) => frame.kind === "tool")).toMatchObject({ label: "shell" })
    expect(RaiRooms.displayText("hello\u001B]8;;https://evil.example\u0007click\u001B]8;;\u0007")).toBe("helloclick")
    expect(RaiRooms.canSend("read")).toBe(false)
    expect(RaiRooms.canSend("write")).toBe(true)
  })

  test("carries approvals and keeps each tool result with its own line", () => {
    const fixture = [
      'data: {"tool":"read","label":"README.md 읽기"}',
      "",
      'data: {"approval":{"id":"a1","kind":"shell","title":"명령 실행","purpose":"README 확인"}}',
      "",
      'data: {"approval_done":"a1","decision":"allow-room"}',
      "",
      'data: {"tool_done":"read","ok":true,"label":"README.md 읽기"}',
      "",
      "",
    ].join("\n")
    const pulled = pushSse("", fixture)
    // Arrival order is what the room draws, so frames must not be reordered or merged.
    expect(pulled.frames.map((frame) => frame.kind)).toEqual(["tool", "approval", "approval_done", "tool_done"])
    expect(pulled.frames.find((frame) => frame.kind === "tool")).toMatchObject({
      label: "README.md 읽기",
      name: "read",
    })
    expect(pulled.frames.find((frame) => frame.kind === "approval")).toMatchObject({
      approvalID: "a1",
      title: "명령 실행",
      purpose: "README 확인",
    })
    expect(pulled.frames.find((frame) => frame.kind === "approval_done")).toMatchObject({
      approvalID: "a1",
      decision: "allow-room",
    })
    expect(pulled.frames.find((frame) => frame.kind === "tool_done")).toMatchObject({ name: "read", ok: true })
  })

  test("explains a missing room scope without retrying a shared limit", () => {
    const message = roomsMessage("scope_missing", "권한이 없습니다", "rooms_write")
    expect(message).toContain(describeFailure("scope_missing", "권한이 없습니다"))
    expect(message).toContain("rooms_write")
    expect(message).toContain("웹에서 승인")
    expect(roomsMessage("share_limited", "공유 한도", "rooms_read")).toBe(describeFailure("share_limited", "공유 한도"))
  })

  test("does not call the gateway until a key is connected", async () => {
    const { http, calls } = httpOf(() => Response.json({}))
    const handlers: Record<string, (input: unknown) => Effect.Effect<unknown>> = {}
    const ctx = {
      rpc: {
        register: (_definition: unknown, next: typeof handlers) => {
          Object.assign(handlers, next)
          return Effect.succeed({ events: { emit: () => Effect.void } })
        },
      },
      integration: {
        connection: {
          active: () => Effect.succeed(undefined),
          resolve: () => Effect.die("resolve"),
        },
      },
    }
    await run(register(ctx, http))
    const projects = (await run(handlers.projects({}))) as { error: string; projects: unknown[] }
    const sent = (await run(handlers.send(sendInput))) as { error: string; text: string }
    expect(projects.error).toBe(connectFirst)
    expect(sent.error).toBe(connectFirst)
    expect(sent.text).toBe("")
    expect(calls).toHaveLength(0)
    expect(keyOf(undefined)).toBeUndefined()
    expect(keyOf({ type: "oauth" })).toBeUndefined()
  })

  test("sends the saved key and the required user agent, never the subscription header", async () => {
    const { http, calls } = httpOf(() => Response.json({ data: [{ id: "proj-1", title: "문서" }] }))
    const projects = await run(listProjects(http, auth))
    expect(projects).toEqual([{ id: "proj-1", title: "문서" }])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${defaultBaseURL}/projects`)
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${key}`)
    expect(calls[0]?.headers.get("user-agent")).toContain("ROKFOSS")
    expect(calls[0]?.headers.get("x-rai-credential")).toBeNull()
  })

  test("reads rooms and a message page without storing them", () => {
    const rooms = parseRooms({
      data: [
        {
          id: "room-1",
          title: "설계",
          project_id: "proj-1",
          provider: "xai",
          model: "grok-4.3",
          updated_at: "2026-11-15T00:00:00Z",
          running: true,
          shared_by: "홍길동",
          perm: "write",
        },
      ],
    })
    expect(rooms).toEqual([
      {
        id: "room-1",
        title: "설계",
        projectID: "proj-1",
        provider: "xai",
        model: "grok-4.3",
        updatedAt: "2026-11-15T00:00:00Z",
        running: true,
        sharedBy: "홍길동",
        perm: "write",
      },
    ])
    const page = parsePage({
      messages: [{ id: "m2", role: "assistant", content: "답" }, { id: "m1", role: "user", text: "질문" }],
      has_more: true,
      oldest_id: "m1",
      access: "read",
      owner: "홍길동",
      me: "나",
      room: { id: "room-1", title: "설계" },
    })
    expect(page?.messages.map((message) => message.text)).toEqual(["답", "질문"])
    expect(page?.hasMore).toBe(true)
    expect(page?.oldestID).toBe("m1")
    expect(page?.access).toBe("read")
    expect(RaiRooms.canSend(page?.access)).toBe(false)
  })

  test("creates an empty room with the first line as its title", async () => {
    const { http, calls } = httpOf(() =>
      Response.json({ object: "rai.room", id: 124, title: "README 요약", project_id: 7, perm: "owner" }),
    )
    const room = await run(createRoom(http, auth, { title: "README 요약\n둘째 줄", projectID: "7" }))
    expect(room.id).toBe("124")
    expect(room.title).toBe("README 요약")
    expect(room.projectID).toBe("7")
    expect(room.perm).toBe("owner")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${defaultBaseURL}/rooms`)
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${key}`)
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ title: "README 요약", project_id: 7 })
  })

  test("refuses a bad project id before sending and maps a refused create", async () => {
    expect(createBody({ title: "x", projectID: null })).toEqual({ ok: true, body: { title: "x" } })
    expect(createBody({ title: "x", projectID: "../1" }).ok).toBe(false)
    expect(createBody({ title: "x", projectID: "-3" }).ok).toBe(false)
    const { http, calls } = httpOf(() =>
      Response.json({ error: { code: "project_read_only", message: "읽기 전용으로 공유된 프로젝트입니다" } }, { status: 403 }),
    )
    const bad = await run(createRoom(http, auth, { title: "x", projectID: "abc" }).pipe(Effect.flip))
    expect(String(bad)).toContain("프로젝트 번호")
    expect(calls).toHaveLength(0)
    const refused = await run(createRoom(http, auth, { title: "x", projectID: "9" }).pipe(Effect.flip))
    expect(String(refused)).toContain("읽기 전용")
    expect((refused as { retry?: boolean }).retry).toBe(false)
  })

  test("does not retry a missing scope or follow it with /responses", async () => {
    const { http, calls } = httpOf(() =>
      Response.json({ error: { code: "scope_missing", message: "권한이 없습니다" } }, { status: 403 }),
    )
    const error = await run(listProjects(http, auth).pipe(Effect.flip))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).not.toContain("/responses")
    expect(String(error)).toContain("권한이 없습니다")
    expect(String(error)).toContain("rooms_read")
    expect((error as { retry?: boolean }).retry).toBe(false)
  })

  test("does not render an HTML error page as chat", async () => {
    const { http, calls } = httpOf(() => new Response("<!DOCTYPE html><title>secret page</title>", { status: 400 }))
    const error = await run(postChat(http, auth, sendInput).pipe(Effect.flip))
    expect(calls).toHaveLength(1)
    expect(error.message).toBe("ROKFOSS AI request failed (400)")
    expect(error.message).not.toContain("secret page")
    expect(error.message).not.toContain("<")
  })

  test("continues a room over SSE and does not execute tools or write the transcript", async () => {
    const sse = [
      ": ping",
      "",
      'data: {"delta":"안녕"}',
      "",
      'data: {"thinking":"hidden"}',
      "",
      'data: {"label":"search","tool":{"arguments":{"q":"secret"}}}',
      "",
      'data: {"tool_done":true,"ok":true}',
      "",
      'data: {"notice":"외부 자료"}',
      "",
      'data: {"done":true}',
      "",
    ].join("\n")
    const { http, calls } = httpOf((input) => {
      expect(input.url).toBe(`${defaultBaseURL}/chat`)
      expect(JSON.parse(input.body)).toEqual({
        room_id: "room-1",
        provider: "xai",
        model: "grok-4.3",
        message: "이어서",
        search: false,
      })
      expect(input.headers.get("x-rai-credential")).toBeNull()
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    })
    const writes: string[] = []
    const result = await run(postChat(http, auth, sendInput, { onFrame: () => Effect.sync(() => writes.push("frame")) }))
    expect(calls).toHaveLength(1)
    expect(result.text).toBe("안녕")
    expect(result.thought).toBe(true)
    expect(result.tools).toEqual([{ label: "search", done: true, ok: true }])
    expect(JSON.stringify(result)).not.toContain("hidden")
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(result.done).toBe(true)
    expect(result.notice).toBe("외부 자료")
    expect(writes.length).toBeGreaterThan(0)
  })

  test("treats an idle stream as absent when the server answers 204", async () => {
    const { http, calls } = httpOf(() => new Response(null, { status: 204 }))
    const watched = await run(watchRoom(http, auth, "room-1"))
    expect(calls[0]?.url).toBe(`${defaultBaseURL}/rooms/room-1/stream`)
    expect(watched.active).toBe(false)
    expect(watched.transcript.text).toBe("")
  })

  test("pages messages with limit and before", async () => {
    const { http, calls } = httpOf(() =>
      Response.json({ messages: [{ id: "m1", role: "user", content: "이전" }], has_more: false, oldest_id: "m1" }),
    )
    const page = await run(readMessages(http, auth, { roomID: "room-1", limit: 20, before: "m9" }))
    expect(calls[0]?.url).toContain("limit=20")
    expect(calls[0]?.url).toContain("before=m9")
    expect(page.messages[0]?.text).toBe("이전")
  })

  test("aborts an in-flight continuation when the caller is interrupted", async () => {
    let signal: AbortSignal | undefined
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const http = HttpClient.make((_request, _url, abort) => {
      signal = abort
      markStarted()
      return Effect.never
    })
    const fiber = Effect.runFork(postChat(http, auth, { ...sendInput, roomID: "0", message: "새 방" }))
    await started
    await run(Fiber.interrupt(fiber))
    expect(signal?.aborted).toBe(true)
  })

  test("keeps room SSE text off the shared RPC event bus", async () => {
    const secret = "room-secret-delta"
    const audience = "a".repeat(22)
    const other = "b".repeat(22)
    const sse = [
      `data: {"delta":"${secret}","thinking":"hidden-thought"}`,
      "",
      "",
    ].join("\n")
    const emitted: unknown[] = []
    const { http, calls } = httpOf(() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    const handlers: Record<string, (input: unknown) => Effect.Effect<unknown>> = {}
    const ctx = {
      rpc: {
        register: (_definition: unknown, next: typeof handlers) => {
          Object.assign(handlers, next)
          return Effect.succeed({
            events: { emit: (...args: unknown[]) => Effect.sync(() => void emitted.push(args)) },
          })
        },
      },
      integration: {
        connection: {
          active: () => Effect.succeed({ type: "credential", id: "rai" }),
          resolve: () => Effect.succeed({ type: "key", key }),
        },
      },
    }
    await run(register(ctx, http))
    const sent = (await run(handlers.send({ ...sendInput, audience, search: false }))) as { text: string }
    const taken = (await run(handlers.take({ audience }))) as { chunk: { text?: string | null } | null; open: boolean }
    const stranger = (await run(handlers.take({ audience: other }))) as { chunk: unknown; open: boolean }
    expect(calls[0] && JSON.parse(calls[0].body).search).toBe(false)
    expect(calls[0] && JSON.parse(calls[0].body).audience).toBeUndefined()
    expect(emitted).toEqual([])
    expect(JSON.stringify(emitted)).not.toContain(secret)
    expect(sent.text).toBe(secret)
    expect(taken.chunk?.text).toBe(secret)
    expect(JSON.stringify(taken)).not.toContain("hidden-thought")
    expect(stranger).toEqual({ chunk: null, open: false })
    expect(JSON.stringify(stranger)).not.toContain(secret)
  })

  test("collapses a run of thinking chunks and drains the mailbox in one take", async () => {
    const audience = "c".repeat(22)
    const thinking = Array.from({ length: 3_000 }, (_, i) => `data: {"thinking":"t${i}"}\n\n`).join("")
    const sse = `${thinking}data: {"delta":"첫 "}\n\ndata: {"tool":"web_search","label":"검색"}\n\ndata: {"delta":"답"}\n\ndata: {"done":true}\n\n`
    const { http } = httpOf(() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    const handlers: Record<string, (input: unknown) => Effect.Effect<unknown>> = {}
    const ctx = {
      rpc: {
        register: (_definition: unknown, next: typeof handlers) => {
          Object.assign(handlers, next)
          return Effect.succeed({ events: { emit: () => Effect.void } })
        },
      },
      integration: {
        connection: {
          active: () => Effect.succeed({ type: "credential", id: "rai" }),
          resolve: () => Effect.succeed({ type: "key", key }),
        },
      },
    }
    await run(register(ctx, http))
    await run(handlers.send({ ...sendInput, audience }))
    const taken = (await run(handlers.take({ audience }))) as RaiRooms.TakeResult
    const all = [taken.chunk, ...(taken.more ?? [])].filter((chunk) => chunk !== null)
    expect(all.map((chunk) => chunk.kind)).toEqual(["thinking", "delta", "tool", "delta", "done"])
    expect(all.filter((chunk) => chunk.kind === "delta").map((chunk) => chunk.text)).toEqual(["첫 ", "답"])
    expect(taken.open).toBe(false)
    expect(await run(handlers.take({ audience }))).toEqual({ chunk: null, open: false })
  })

  test("wakes only the caller waiting on that audience", async () => {
    const secret = "waiter-only-delta"
    const audience = "c".repeat(22)
    let release: () => void = () => {}
    const opened = new Promise<void>((resolve) => {
      release = resolve
    })
    const sse = `data: {"delta":"${secret}"}

`
    const { http } = httpOf(async (input) => {
      if (input.url.endsWith("/chat")) {
        await opened
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return Response.json({})
    })
    const handlers: Record<string, (input: unknown) => Effect.Effect<unknown>> = {}
    await run(
      Effect.scoped(
        registerRooms(
        {
          rpc: {
            register: (_definition: unknown, next: typeof handlers) => {
              Object.assign(handlers, next)
              return Effect.succeed({ events: { emit: () => Effect.void } })
            },
          },
          integration: {
            connection: {
              active: () => Effect.succeed({ type: "credential", id: "rai" }),
              resolve: () => Effect.succeed({ type: "key", key }),
            },
          },
        } as never,
        http,
      ),
      ),
    )
    const sending = run(handlers.send({ ...sendInput, audience, search: false }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const taking = run(handlers.take({ audience }))
    const stranger = run(handlers.take({ audience: "d".repeat(22) }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    const [sent, taken, other] = await Promise.all([
      sending,
      taking,
      stranger,
    ])
    expect((sent as { text: string }).text).toBe(secret)
    expect((taken as { chunk: { text?: string | null } | null }).chunk?.text).toBe(secret)
    expect(other).toEqual({ chunk: null, open: false })
  })
})

describe("오류 본문 두 꼴", () => {
  // Spec 3.7 now answers an OpenAI-shaped error; spec 3.5 keeps the web shape. Both must yield the same code.
  test("OpenAI 꼴에서 code 를 읽는다", () => {
    const error = failureFrom(
      409,
      JSON.stringify({ error: { message: "이 방은 지금 답이 도는 중입니다", type: "rate_limit", code: "room_busy" } }),
      "rooms_write",
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe("room_busy")
    expect(error.retry).toBe(false)
  })

  test("웹 꼴에서도 code 와 문구를 읽는다", () => {
    const error = failureFrom(409, JSON.stringify({ error: "이 방은 지금 답이 도는 중입니다", code: "room_busy" }), "rooms_write")
    expect(error.code).toBe("room_busy")
    expect(error.message).toContain("이 방은 지금 답이 도는 중입니다")
  })

  // 404 is the one exception the spec keeps in the web shape.
  test("웹 꼴 404 는 문구를 그대로 쓴다", () => {
    const error = failureFrom(404, JSON.stringify({ error: "채팅방을 찾을 수 없습니다" }), "rooms_read")
    expect(error.status).toBe(404)
    expect(error.message).toContain("채팅방을 찾을 수 없습니다")
  })

  test("HTML 403 은 상태만 남긴다", () => {
    const error = failureFrom(403, "<!doctype html><html>blocked</html>", "rooms_read")
    expect(error.status).toBe(403)
    expect(error.message).not.toContain("<")
  })
})
