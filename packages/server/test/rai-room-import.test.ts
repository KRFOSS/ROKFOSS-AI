import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { roomImport } from "../../tui/src/component/rooms-import"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
  })
  return (path: string, body?: unknown, status = 200) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const json: unknown = await response.json()
      if (response.status !== status) console.error(JSON.stringify(json))
      expect(response.status).toBe(status)
      return json
    })
})

// A ROKFOSS AI room opened in OpenCode becomes a session whose history is the room's conversation.
it.live("imports a room conversation as a session the server accepts and reads back", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const template = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", {}))
    const id = Session.ID.create()
    const built = roomImport({
      sessionID: id,
      roomID: "42",
      title: "설계",
      agent: "build",
      model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
      projectID: template.data.projectID,
      directory: template.data.location.directory,
      now: 1_000,
      messages: [
        { id: "1", role: "user", text: "질문", createdAt: "2026-11-17T00:00:00Z" },
        { id: "2", role: "assistant", text: "답", thinking: "먼저 따져 보면", provider: "codex", model: "gpt-5.5", createdAt: null },
      ],
    })
    yield* request("/api/experimental/session/import", built)
    const read = Schema.decodeUnknownSync(SessionResponse)(yield* request(`/api/session/${id}`))
    expect(read.data.title).toBe("설계")
    expect(read.data.metadata).toMatchObject({ rai: { roomID: "42" } })
    expect(yield* request(`/api/session/${id}/message?order=asc`)).toMatchObject({
      data: [
        { type: "user", text: "질문", metadata: { rai: { roomID: "42", messageID: "1" } } },
        {
          type: "assistant",
          model: { providerID: "rai", id: "codex/gpt-5.5" },
          content: [
            { type: "reasoning", text: "먼저 따져 보면" },
            { type: "text", text: "답" },
          ],
        },
      ],
    })
  }).pipe(Effect.scoped),
)
