import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMirror } from "@opencode/core/session/mirror"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Model } from "@opencode/schema/model"
import { Effect, Fiber, Stream } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = Model.Ref.make({ providerID: "rai" as never, id: "codex/gpt-5.5" as never })

const eventTypes = Effect.fnUntraced(function* (sessionID: Session.ID) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .all()
  return rows.map((row) => row.type)
})

describe("Session.mirror", () => {
  it.effect("shows a line written elsewhere as a delivered user message without running the session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      const mine = yield* session.mirror.user({ sessionID: created.id, text: "웹에서 친 글" })
      const shared = yield* session.mirror.user({
        sessionID: created.id,
        text: "공유한 사람의 글",
        author: "앨리스",
        metadata: { rai: { messageID: "3" } },
      })

      const messages = yield* session.messages({ sessionID: created.id })
      expect(messages.map((message) => message.type)).toEqual(["user", "user"])
      expect(messages.find((message) => message.id === mine)).toMatchObject({ type: "user", text: "웹에서 친 글" })
      expect(messages.find((message) => message.id === shared)).toMatchObject({
        type: "user",
        text: "앨리스: 공유한 사람의 글",
        metadata: { rai: { messageID: "3" }, mirror: { author: "앨리스" } },
      })
      expect(yield* session.inbox(created.id)).toEqual([])
      const types = yield* eventTypes(created.id)
      expect(types.some((type) => type.includes("session.execution."))).toBe(false)
    }),
  )

  it.effect("streams an answer written elsewhere as an assistant message with its reasoning", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      // Deltas are live-only: a client draws the answer from them as it arrives.
      const live: string[] = []
      const collector = yield* bus.subscribe([SessionEvent.Text.Delta, SessionEvent.Reasoning.Delta]).pipe(
        Stream.runForEach((event) => Effect.sync(() => void live.push(`${event.type}:${event.data.delta}`))),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.yieldNow
      const answer = yield* session.mirror.answer({ sessionID: created.id, model, metadata: { rai: { messageID: "2" } } })
      yield* answer.reasoning("먼저 ")
      yield* answer.text("안")
      yield* answer.reasoning("따져 보면")
      yield* answer.text("녕")
      yield* answer.end({ text: "안녕하세요" })
      yield* answer.end({ text: "두 번째 끝은 무시한다" })
      yield* answer.text("끝난 뒤 조각도 무시한다")

      for (let i = 0; i < 10 && live.length < 4; i++) yield* Effect.yieldNow
      yield* Fiber.interrupt(collector)
      expect(live).toEqual([
        "session.reasoning.delta:먼저 ",
        "session.text.delta:안",
        "session.reasoning.delta:따져 보면",
        "session.text.delta:녕",
      ])
      const messages = yield* session.messages({ sessionID: created.id })
      expect(messages).toHaveLength(1)
      const message = messages[0]
      if (message?.type !== "assistant") throw new Error("expected an assistant message")
      expect(message.id).toBe(answer.messageID)
      expect(message.model).toMatchObject({ providerID: "rai", id: "codex/gpt-5.5" })
      expect(message.metadata).toMatchObject({ rai: { messageID: "2" }, mirror: {} })
      expect(message.finish).toBe("stop")
      expect(message.time.completed).toBeDefined()
      expect(message.content.map((part) => part.type)).toEqual(["reasoning", "text"])
      expect(message.content[0]).toMatchObject({ type: "reasoning", text: "먼저 따져 보면" })
      expect(message.content[1]).toMatchObject({ type: "text", text: "안녕하세요" })
      const types = yield* eventTypes(created.id)
      expect(types.some((type) => type.includes("session.execution."))).toBe(false)
    }),
  )

  it.effect("ends a failed answer as a failed step and keeps what streamed", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      const answer = yield* session.mirror.answer({ sessionID: created.id, model })
      yield* answer.text("중간까지")
      yield* answer.end({ error: "업스트림 오류" })

      const [message] = yield* session.messages({ sessionID: created.id })
      if (message?.type !== "assistant") throw new Error("expected an assistant message")
      expect(message.error).toMatchObject({ type: "mirror", message: "업스트림 오류" })
      expect(message.content).toMatchObject([{ type: "text", text: "중간까지" }])
    }),
  )

  it.effect("waits while the session runs a turn of its own", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      const mirror = SessionMirror.make({ bus, get: session.get, isActive: () => Effect.succeed(true) })
      const busy = new Session.BusyError({ sessionID: created.id })
      expect(yield* Effect.flip(mirror.user({ sessionID: created.id, text: "글" }))).toEqual(busy)
      expect(yield* Effect.flip(mirror.answer({ sessionID: created.id, model }))).toEqual(busy)
      expect(yield* session.messages({ sessionID: created.id })).toEqual([])
    }),
  )

  it.effect("rejects an unknown session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sessionID = Session.ID.make("ses_missing_mirror")
      expect(yield* Effect.flip(session.mirror.user({ sessionID, text: "글" }))).toEqual(
        new Session.NotFoundError({ sessionID }),
      )
      expect(yield* Effect.flip(session.mirror.answer({ sessionID, model }))).toEqual(
        new Session.NotFoundError({ sessionID }),
      )
    }),
  )
})
